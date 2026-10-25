<?php

namespace App\Services\Osm\Import;

use App\Services\Gis\GeoJsonBoundary;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Throwable;

class OsmAddressImporter
{
    public const SOURCE = 'OpenStreetMap';

    public const DATASET = 'addresses';

    public function __construct(private OsmAddressReader $reader, private GeoJsonBoundary $boundary) {}

    public function import(string $file, string $boundaryFile, array $options = []): array
    {
        if (DB::getDriverName() !== 'pgsql') {
            throw new RuntimeException('Address import requires PostgreSQL/PostGIS.');
        }
        $contents = $this->readFile($file);
        $boundaryContents = $this->readFile($boundaryFile);
        $document = $this->reader->read($contents);
        $configuration = [
            'importer_version' => 1, 'boundary_sha256' => hash('sha256', $boundaryContents),
            'source_updated_at' => $document['osm3s']['timestamp_osm_base'] ?? null,
            'point_method' => 'osm_node_or_point_on_surface', 'boundary_rule' => 'covers_analysis_point',
            'observed_at' => null,
        ];
        $identity = ['source' => self::SOURCE, 'dataset_key' => self::DATASET,
            'checksum_sha256' => hash('sha256', $contents), 'configuration_sha256' => hash('sha256', $this->json($configuration))];
        unset($contents);
        $boundary = $this->boundary->geometry($boundaryContents);
        $lock = 'web_gis:'.self::SOURCE.':'.self::DATASET;
        if (! DB::selectOne('SELECT pg_try_advisory_lock(hashtextextended(?,0)) AS acquired', [$lock])->acquired) {
            throw new RuntimeException('Another address import is already running.');
        }
        $importId = null;
        $report = [];
        try {
            if (! ($options['dry_run'] ?? false)) {
                $existing = DB::table('dataset_imports')->where($identity)->where('status', 'succeeded')->first();
                if ($existing) {
                    return ['status' => 'skipped', 'import_id' => $existing->id, 'report' => json_decode($existing->result, true)];
                }
                $importId = DB::table('dataset_imports')->insertGetId($identity + [
                    'source_url' => 'https://www.openstreetmap.org/', 'source_version' => $configuration['source_updated_at'],
                    'source_updated_at' => $configuration['source_updated_at'], 'observed_at' => null,
                    'configuration' => $this->json($configuration), 'status' => 'running',
                ]);
            }

            return DB::transaction(function () use ($document, $boundary, $options, $importId, &$report) {
                // A transaction-local stage avoids per-row writes and never exposes a partial snapshot.
                $stage = 'osm_address_stage_'.bin2hex(random_bytes(6));
                DB::statement("CREATE TEMP TABLE {$stage} ON COMMIT DROP AS SELECT * FROM osm_addresses WITH NO DATA");
                $report = ['input_objects' => count($document['elements']), 'auxiliary_relations' => 0,
                    'accepted_addresses' => 0, 'skipped' => [], 'warnings' => [], 'large_drop' => false];
                $batch = [];
                foreach ($this->reader->candidates($document) as $candidate) {
                    if (isset($candidate['skip'])) {
                        if ($candidate['skip'] === 'auxiliary_relation') {
                            $report['auxiliary_relations']++;
                        } else {
                            $report['skipped'][] = ['source_id' => $candidate['source_id'], 'reason' => $candidate['skip']];
                        }

                        continue;
                    }
                    if ($candidate['warnings']) {
                        $report['warnings'][] = ['source_id' => $candidate['source_id'], 'issues' => $candidate['warnings']];
                    }
                    $batch[] = $candidate['row'];
                    if (count($batch) === 500) {
                        $this->stage($batch, $stage, $boundary, $report);
                        $batch = [];
                    }
                }
                if ($batch) {
                    $this->stage($batch, $stage, $boundary, $report);
                }
                $count = $report['accepted_addresses'];
                if (! $count) {
                    throw new RuntimeException('No valid addresses inside boundary; refusing to publish an empty snapshot.');
                }
                $previous = DB::table('dataset_imports')->where('source', self::SOURCE)->where('dataset_key', self::DATASET)->where('is_active', true)->first();
                $report['large_drop'] = $previous && $count < $previous->row_count * 0.8;
                if ($options['dry_run'] ?? false) {
                    DB::statement("DROP TABLE {$stage}");

                    return ['status' => 'dry-run', 'import_id' => null, 'report' => $report];
                }
                if ($report['large_drop'] && ! ($options['allow_large_drop'] ?? false)) {
                    throw new RuntimeException('Address count decreased by more than 20%; inspect --dry-run before --allow-large-drop.');
                }
                DB::statement("INSERT INTO osm_addresses (dataset_import_id, osm_type, osm_id, osm_version, osm_updated_at,
                    street, place, house_number, locality, postcode, label, source_geom, geom, point_method, raw_data)
                    SELECT ?, osm_type, osm_id, osm_version, osm_updated_at, street, place, house_number, locality, postcode,
                    label, source_geom, geom, point_method, raw_data FROM {$stage}", [$importId]);
                DB::statement("DROP TABLE {$stage}");
                // Prepare aliases before publication; a failure rolls back rows and keeps the old snapshot active.
                DB::selectOne('SELECT osm_address_search_rebuild(?) AS prepared', [$importId]);
                DB::table('dataset_imports')->where('source', self::SOURCE)->where('dataset_key', self::DATASET)->where('is_active', true)->update(['is_active' => false]);
                DB::table('dataset_imports')->where('id', $importId)->update([
                    'status' => 'succeeded', 'is_active' => true, 'finished_at' => DB::raw('GREATEST(started_at,clock_timestamp())'),
                    'row_count' => $count, 'result' => $this->json($report),
                ]);

                return ['status' => 'succeeded', 'import_id' => $importId, 'report' => $report];
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
            DB::selectOne('SELECT pg_advisory_unlock(hashtextextended(?,0))', [$lock]);
        }
    }

    private function stage(array $batch, string $table, string $boundary, array &$report): void
    {
        $checks = DB::select(<<<'SQL'
            WITH input AS (
                SELECT source_id, ST_GeomFromGeoJSON(geometry) AS g
                FROM jsonb_to_recordset(?::jsonb) AS x(source_id text, geometry jsonb)
            ), valid AS (
                SELECT *, ST_IsValid(g) AND NOT ST_IsEmpty(g) AS valid FROM input
            ), points AS (
                SELECT *, CASE WHEN valid THEN ST_PointOnSurface(g) END AS p FROM valid
            )
            SELECT source_id, valid, CASE WHEN NOT valid THEN ST_IsValidReason(g) END AS validity_reason, CASE WHEN valid THEN ST_Covers(ST_GeomFromGeoJSON(?), p) ELSE false END AS inside,
                CASE WHEN valid THEN ST_Covers(ST_GeomFromGeoJSON(?), g) ELSE false END AS fully_inside
            FROM points
            SQL, [$this->json($batch), $boundary, $boundary]);
        $accepted = [];
        foreach ($checks as $check) {
            if (! $check->valid || ! $check->inside) {
                $report['skipped'][] = ['source_id' => $check->source_id, 'reason' => $check->valid ? 'outside_boundary' : 'invalid_geometry', 'detail' => $check->validity_reason];
            } else {
                $accepted[$check->source_id] = true;
                if (! $check->fully_inside) {
                    $report['warnings'][] = ['source_id' => $check->source_id, 'issues' => ['source_crosses_boundary']];
                }
            }
        }
        $selected = array_values(array_filter($batch, fn ($r) => isset($accepted[$r['source_id']])));
        $report['accepted_addresses'] += count($selected);
        if (! $selected) {
            return;
        }
        DB::statement("INSERT INTO {$table} (osm_type, osm_id, osm_version, osm_updated_at, street, place, house_number,
                locality, postcode, label, source_geom, geom, point_method, raw_data)
            SELECT osm_type, osm_id, osm_version, osm_updated_at, street, place, house_number, locality, postcode, label,
                ST_GeomFromGeoJSON(geometry), ST_PointOnSurface(ST_GeomFromGeoJSON(geometry)), point_method, raw_data
            FROM jsonb_to_recordset(?::jsonb) AS x(osm_type text, osm_id bigint, osm_version integer, osm_updated_at timestamptz,
                street text, place text, house_number text, locality text, postcode text, label text,
                geometry jsonb, point_method text, raw_data jsonb)", [$this->json($selected)]);
    }

    private function readFile(string $path): string
    {
        if (! is_file($path) || ! is_readable($path)) {
            throw new RuntimeException('Not a readable local file: '.$path);
        }
        $contents = file_get_contents($path);
        if ($contents === false) {
            throw new RuntimeException('Cannot read file: '.$path);
        }

        return $contents;
    }

    private function json(array $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    }
}
