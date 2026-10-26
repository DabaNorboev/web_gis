<?php

namespace App\Services\Osm\Import;

use App\Services\Gis\DatasetCoverage;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Throwable;

/** Atomic imports for the two explicitly supported linear datasets, not a routing graph. */
class OsmLinearImporter
{
    public const SOURCE = 'OpenStreetMap';

    public function __construct(private OsmLinearReader $reader, private DatasetCoverage $coverage) {}

    public function import(OsmLinearDataset $dataset, string $file, string $boundaryFile, array $options = []): array
    {
        $started = microtime(true);
        if (DB::getDriverName() !== 'pgsql') {
            throw new RuntimeException('Linear import requires PostgreSQL/PostGIS.');
        }
        $contents = $this->readFile($file);
        $checksum = hash('sha256', $contents);
        if (isset($options['expected_sha256']) && $options['expected_sha256'] !== $checksum) {
            throw new RuntimeException('Input SHA-256 does not match the expected snapshot.');
        }
        $document = $this->reader->read($contents);
        unset($contents);
        $boundaryContents = $this->readFile($boundaryFile);
        $coverage = $this->coverage->prepare($boundaryContents, $options['buffer_m'] ?? 0);
        $this->coverage->validatePreparation($document, $coverage);
        $boundary = $coverage['data_geometry'];
        $url = $options['source_url'] ?? 'https://www.openstreetmap.org/';
        if (! filter_var($url, FILTER_VALIDATE_URL) || ! in_array(parse_url($url, PHP_URL_SCHEME), ['http', 'https'], true)) {
            throw new RuntimeException('Source URL must be HTTP(S); it is recorded, never fetched.');
        }
        $configuration = [
            'importer_version' => 2, 'tag' => $dataset->tag(), 'types' => $dataset->types(),
            'spatial_coverage' => $this->coverage->metadata($coverage),
            'lifecycle_exclusions' => OsmLinearReader::LIFECYCLE_TAGS,
            'boundary_sha256' => hash('sha256', $boundaryContents), 'selection_boundary' => json_decode($boundary, true),
            'boundary_rule' => 'intersects_preserve_full_line', 'coverage' => 'selection_area_not_real_world_completeness',
            'source_updated_at' => $document['osm3s']['timestamp_osm_base'] ?? null, 'source_url' => $url,
            'preparation' => $document['preparation'] ?? null, 'observed_at' => null,
        ];
        $identity = ['source' => self::SOURCE, 'dataset_key' => $dataset->value,
            'checksum_sha256' => $checksum, 'configuration_sha256' => hash('sha256', $this->json($configuration))];
        $key = 'web_gis:'.self::SOURCE.':'.$dataset->value;
        if (! DB::selectOne('SELECT pg_try_advisory_lock(hashtextextended(?,0)) AS acquired', [$key])->acquired) {
            throw new RuntimeException('Another '.$dataset->value.' import is already running.');
        }
        $importId = null;
        $report = [];
        try {
            if (! ($options['dry_run'] ?? false)) {
                $existing = DB::table('dataset_imports')->where($identity)->where('status', 'succeeded')->first();
                if ($existing) {
                    return ['status' => 'skipped', 'import_id' => $existing->id, 'is_active' => $existing->is_active, 'report' => json_decode($existing->result, true)];
                }
                $importId = DB::table('dataset_imports')->insertGetId($identity + [
                    'source_url' => $url, 'source_version' => $configuration['source_updated_at'],
                    'source_updated_at' => $configuration['source_updated_at'], 'observed_at' => null,
                    'configuration' => $this->json($configuration), 'status' => 'running',
                ]);
            }

            return DB::transaction(function () use ($dataset, $document, $boundary, $coverage, $options, $importId, $started, &$report) {
                $table = $dataset->table(); // Both identifiers come from the enum, never from raw input.
                $stage = 'osm_linear_stage_'.bin2hex(random_bytes(6));
                DB::statement("CREATE TEMP TABLE {$stage} ON COMMIT DROP AS SELECT * FROM {$table} WITH NO DATA");
                $report = ['dataset' => $dataset->value, 'input_objects' => count($document['elements']),
                    'not_selected' => 0, 'ignored_counts' => [], 'accepted_objects' => 0, 'feature_type_counts' => [],
                    'skipped' => [], 'warnings' => [], 'large_drop' => false];
                $batch = [];
                foreach ($this->reader->candidates($document, $dataset) as $candidate) {
                    if (isset($candidate['ignored'])) {
                        $report['not_selected']++;
                        $reason = $candidate['ignored'];
                        $report['ignored_counts'][$reason] = ($report['ignored_counts'][$reason] ?? 0) + 1;
                    } elseif (isset($candidate['skip'])) {
                        $report['skipped'][] = ['source_id' => $candidate['source_id'], 'reason' => $candidate['skip']];
                    } else {
                        $batch[] = $candidate['row'];
                        if (count($batch) === 500) {
                            $this->stage($batch, $stage, $boundary, $report);
                            $batch = [];
                        }
                    }
                }
                if ($batch) {
                    $this->stage($batch, $stage, $boundary, $report);
                }
                $count = DB::table($stage)->count();
                $report['accepted_objects'] = $count;
                $report['feature_type_counts'] = DB::table($stage)->selectRaw('feature_type,count(*) AS total')->groupBy('feature_type')->orderBy('feature_type')->pluck('total', 'feature_type')->all();
                if (! $count) {
                    throw new RuntimeException('No valid '.$dataset->value.' inside boundary; refusing to publish an empty snapshot.');
                }
                if ($report['input_objects'] !== $count + $report['not_selected'] + count($report['skipped'])) {
                    throw new RuntimeException('Linear import counts do not reconcile.');
                }
                $previous = DB::table('dataset_imports')->where('source', self::SOURCE)->where('dataset_key', $dataset->value)->where('is_active', true)->first();
                $report['large_drop'] = $previous && $count < $previous->row_count * 0.8;
                if ($options['dry_run'] ?? false) {
                    DB::statement("DROP TABLE {$stage}");
                    $report['duration_seconds'] = round(microtime(true) - $started, 3);
                    $report['php_peak_memory_bytes'] = memory_get_peak_usage(true);

                    return ['status' => 'dry-run', 'import_id' => null, 'report' => $report];
                }
                if ($report['large_drop'] && ! ($options['allow_large_drop'] ?? false)) {
                    throw new RuntimeException('Linear object count decreased by more than 20%; inspect --dry-run before --allow-large-drop.');
                }
                DB::statement("INSERT INTO {$table} (dataset_import_id,osm_type,osm_id,osm_version,osm_updated_at,feature_type,name,ref,geom,crosses_boundary,raw_data)
                    SELECT ?,osm_type,osm_id,osm_version,osm_updated_at,feature_type,name,ref,geom,crosses_boundary,raw_data FROM {$stage}", [$importId]);
                DB::statement("DROP TABLE {$stage}");
                $this->coverage->store($importId, $coverage);
                DB::table('dataset_imports')->where('source', self::SOURCE)->where('dataset_key', $dataset->value)->where('is_active', true)->update(['is_active' => false]);
                $report['duration_seconds'] = round(microtime(true) - $started, 3);
                $report['php_peak_memory_bytes'] = memory_get_peak_usage(true);
                DB::table('dataset_imports')->where('id', $importId)->update([
                    'status' => 'succeeded', 'is_active' => true, 'finished_at' => DB::raw('GREATEST(started_at,clock_timestamp())'),
                    'row_count' => $count, 'result' => $this->json($report),
                ]);

                return ['status' => 'succeeded', 'import_id' => $importId, 'is_active' => true, 'report' => $report];
            });
        } catch (Throwable $error) {
            if ($importId !== null) {
                DB::table('dataset_imports')->where('id', $importId)->update([
                    'status' => 'failed', 'finished_at' => DB::raw('GREATEST(started_at,clock_timestamp())'),
                    'result' => $this->json($report), 'error_message' => $error->getMessage(),
                ]);
            }
            throw $error;
        } finally {
            DB::selectOne('SELECT pg_advisory_unlock(hashtextextended(?,0))', [$key]);
        }
    }

    private function stage(array $batch, string $table, string $boundary, array &$report): void
    {
        $checks = DB::select(<<<'SQL'
            WITH input AS (
                SELECT source_id,ST_GeomFromGeoJSON(geometry) AS g
                FROM jsonb_to_recordset(?::jsonb) AS x(source_id text,geometry jsonb)
            ), checked AS (SELECT *,ST_IsValid(g) AND NOT ST_IsEmpty(g) AS valid FROM input)
            SELECT source_id,valid,CASE WHEN NOT valid THEN ST_IsValidReason(g) END AS reason,
                CASE WHEN valid THEN ST_Intersects(ST_GeomFromGeoJSON(?),g) ELSE false END AS inside,
                CASE WHEN valid THEN ST_Covers(ST_GeomFromGeoJSON(?),g) ELSE false END AS fully_inside FROM checked
            SQL, [$this->json($batch), $boundary, $boundary]);
        $accepted = [];
        foreach ($checks as $check) {
            if (! $check->valid || ! $check->inside) {
                $report['skipped'][] = ['source_id' => $check->source_id, 'reason' => $check->valid ? 'outside_boundary' : 'invalid_geometry', 'detail' => $check->reason];
            } else {
                $accepted[$check->source_id] = ! $check->fully_inside;
                if (! $check->fully_inside) {
                    $report['warnings'][] = ['source_id' => $check->source_id, 'reason' => 'source_crosses_boundary'];
                }
            }
        }
        $selected = [];
        foreach ($batch as $row) {
            if (array_key_exists($row['source_id'], $accepted)) {
                $row['crosses_boundary'] = $accepted[$row['source_id']];
                $selected[] = $row;
            }
        }
        if ($selected) {
            DB::statement("INSERT INTO {$table} (osm_type,osm_id,osm_version,osm_updated_at,feature_type,name,ref,geom,crosses_boundary,raw_data)
                SELECT osm_type,osm_id,osm_version,osm_updated_at,feature_type,name,ref,ST_GeomFromGeoJSON(geometry),crosses_boundary,raw_data
                FROM jsonb_to_recordset(?::jsonb) AS x(osm_type text,osm_id bigint,osm_version integer,osm_updated_at timestamptz,
                    feature_type text,name text,ref text,geometry jsonb,crosses_boundary boolean,raw_data jsonb)", [$this->json($selected)]);
        }
    }

    private function readFile(string $path): string
    {
        if (! is_file($path) || ! is_readable($path) || ($contents = file_get_contents($path)) === false) {
            throw new RuntimeException('Not a readable local file: '.$path);
        }

        return $contents;
    }

    private function json(array $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    }
}
