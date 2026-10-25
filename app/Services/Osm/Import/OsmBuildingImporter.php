<?php

namespace App\Services\Osm\Import;

use App\Services\Gis\GeoJsonBoundary;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Throwable;

class OsmBuildingImporter
{
    public const SOURCE = 'OpenStreetMap';

    public const DATASET = 'buildings';

    public function __construct(private OsmBuildingReader $reader, private GeoJsonBoundary $boundary) {}

    public function import(string $file, string $boundaryFile, array $options = []): array
    {
        $startedAt = microtime(true);
        if (DB::getDriverName() !== 'pgsql') {
            throw new RuntimeException('Building import requires PostgreSQL/PostGIS.');
        }
        $contents = $this->readFile($file);
        $checksum = hash('sha256', $contents);
        if (isset($options['expected_sha256']) && $options['expected_sha256'] !== $checksum) {
            throw new RuntimeException('Input SHA-256 does not match the expected snapshot.');
        }
        $document = $this->reader->read($contents);
        unset($contents);
        $boundaryContents = $this->readFile($boundaryFile);
        $boundary = $this->boundary->geometry($boundaryContents);
        $sourceUrl = $options['source_url'] ?? 'https://www.openstreetmap.org/';
        if (! filter_var($sourceUrl, FILTER_VALIDATE_URL) || ! in_array(parse_url($sourceUrl, PHP_URL_SCHEME), ['http', 'https'], true)) {
            throw new RuntimeException('Source URL must be an absolute HTTP(S) URL; it is recorded, never fetched.');
        }
        $configuration = [
            'importer_version' => 1, 'boundary_sha256' => hash('sha256', $boundaryContents),
            'selection_boundary' => json_decode($boundary, true), 'boundary_rule' => 'intersects_preserve_full_geometry',
            'coverage' => 'selected_boundary_without_buffer_not_real_world_completeness',
            'source_updated_at' => $document['osm3s']['timestamp_osm_base'] ?? null, 'source_url' => $sourceUrl,
            'part_rule' => 'building_part_takes_precedence',
            'outer_member_rule' => 'explicit_outer_membership_and_valid_building_parent_covers_member',
            'observed_at' => null,
        ];
        $identity = ['source' => self::SOURCE, 'dataset_key' => self::DATASET,
            'checksum_sha256' => $checksum, 'configuration_sha256' => hash('sha256', $this->json($configuration))];
        $lock = 'web_gis:'.self::SOURCE.':'.self::DATASET;
        if (! DB::selectOne('SELECT pg_try_advisory_lock(hashtextextended(?,0)) AS acquired', [$lock])->acquired) {
            throw new RuntimeException('Another building import is already running.');
        }
        $importId = null;
        $report = [];
        try {
            if (! ($options['dry_run'] ?? false)) {
                $existing = DB::table('dataset_imports')->where($identity)->where('status', 'succeeded')->first();
                if ($existing) {
                    return ['status' => 'skipped', 'import_id' => $existing->id, 'is_active' => $existing->is_active,
                        'report' => json_decode($existing->result, true)];
                }
                $importId = DB::table('dataset_imports')->insertGetId($identity + [
                    'source_url' => $sourceUrl, 'source_version' => $configuration['source_updated_at'],
                    'source_updated_at' => $configuration['source_updated_at'], 'observed_at' => null,
                    'configuration' => $this->json($configuration), 'status' => 'running',
                ]);
            }

            return DB::transaction(function () use ($document, $boundary, $options, $importId, $startedAt, &$report) {
                $stage = 'osm_building_stage_'.bin2hex(random_bytes(6));
                DB::statement("CREATE TEMP TABLE {$stage} ON COMMIT DROP AS SELECT * FROM osm_buildings WITH NO DATA");
                $report = ['input_objects' => count($document['elements']), 'accepted_objects' => 0,
                    'buildings' => 0, 'parts' => 0, 'independent_building_objects' => 0,
                    'skipped' => [], 'warnings' => [], 'count_exclusions' => [], 'large_drop' => false];
                $batch = [];
                foreach ($this->reader->candidates($document) as $candidate) {
                    if (isset($candidate['skip'])) {
                        $report['skipped'][] = ['source_id' => $candidate['source_id'], 'reason' => $candidate['skip']];

                        continue;
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
                $this->classifyOuterMembers($stage, $report);
                $counts = DB::selectOne("SELECT count(*) AS total,
                    count(*) FILTER (WHERE feature_kind='building') AS buildings,
                    count(*) FILTER (WHERE feature_kind='part') AS parts,
                    count(*) FILTER (WHERE feature_kind='building' AND count_exclusion IS NULL) AS independent
                    FROM {$stage}");
                $report['accepted_objects'] = $counts->total;
                $report['buildings'] = $counts->buildings;
                $report['parts'] = $counts->parts;
                $report['independent_building_objects'] = $counts->independent;
                if (! $counts->independent) {
                    throw new RuntimeException('No valid independent building objects inside boundary; refusing to publish.');
                }
                if ($report['input_objects'] !== $counts->total + count($report['skipped'])) {
                    throw new RuntimeException('Building import counts do not reconcile.');
                }
                $previous = DB::table('dataset_imports')->where('source', self::SOURCE)->where('dataset_key', self::DATASET)->where('is_active', true)->first();
                $previousIndependent = $previous ? (json_decode($previous->result, true)['independent_building_objects'] ?? $previous->row_count) : 0;
                $report['large_drop'] = $previous && ($counts->total < $previous->row_count * 0.8 || $counts->independent < $previousIndependent * 0.8);
                if ($options['dry_run'] ?? false) {
                    DB::statement("DROP TABLE {$stage}");
                    $report['duration_seconds'] = round(microtime(true) - $startedAt, 3);
                    $report['php_peak_memory_bytes'] = memory_get_peak_usage(true);

                    return ['status' => 'dry-run', 'import_id' => null, 'report' => $report];
                }
                if ($report['large_drop'] && ! ($options['allow_large_drop'] ?? false)) {
                    throw new RuntimeException('Building objects or independent buildings decreased by more than 20%; inspect --dry-run before --allow-large-drop.');
                }
                DB::statement("INSERT INTO osm_buildings (dataset_import_id,osm_type,osm_id,osm_version,osm_updated_at,
                    feature_kind,geom,crosses_boundary,parent_relations,count_exclusion,raw_data)
                    SELECT ?,osm_type,osm_id,osm_version,osm_updated_at,feature_kind,geom,crosses_boundary,parent_relations,count_exclusion,raw_data
                    FROM {$stage}", [$importId]);
                DB::statement("DROP TABLE {$stage}");
                DB::table('dataset_imports')->where('source', self::SOURCE)->where('dataset_key', self::DATASET)->where('is_active', true)->update(['is_active' => false]);
                $report['duration_seconds'] = round(microtime(true) - $startedAt, 3);
                $report['php_peak_memory_bytes'] = memory_get_peak_usage(true);
                DB::table('dataset_imports')->where('id', $importId)->update([
                    'status' => 'succeeded', 'is_active' => true, 'finished_at' => DB::raw('GREATEST(started_at,clock_timestamp())'),
                    'row_count' => $counts->total, 'result' => $this->json($report),
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
            DB::selectOne('SELECT pg_advisory_unlock(hashtextextended(?,0))', [$lock]);
        }
    }

    private function stage(array $batch, string $table, string $boundary, array &$report): void
    {
        $checks = DB::select(<<<'SQL'
            WITH input AS (
                SELECT source_id, ST_GeomFromGeoJSON(geometry) AS g
                FROM jsonb_to_recordset(?::jsonb) AS x(source_id text,geometry jsonb)
            ), checked AS (SELECT *,ST_IsValid(g) AND NOT ST_IsEmpty(g) AS valid FROM input)
            SELECT source_id,valid,CASE WHEN NOT valid THEN ST_IsValidReason(g) END AS reason,
                CASE WHEN valid THEN ST_Intersects(ST_GeomFromGeoJSON(?),g) ELSE false END AS inside,
                CASE WHEN valid THEN ST_Covers(ST_GeomFromGeoJSON(?),g) ELSE false END AS fully_inside FROM checked
            SQL, [$this->json($batch), $boundary, $boundary]);
        $accepted = [];
        foreach ($checks as $check) {
            if (! $check->valid || ! $check->inside) {
                $report['skipped'][] = ['source_id' => $check->source_id,
                    'reason' => $check->valid ? 'outside_boundary' : 'invalid_geometry', 'detail' => $check->reason];
            } else {
                $accepted[$check->source_id] = ! $check->fully_inside;
                if (! $check->fully_inside) {
                    $report['warnings'][] = ['source_id' => $check->source_id, 'reason' => 'source_crosses_boundary'];
                }
            }
        }
        $selected = [];
        foreach ($batch as $row) {
            if (! array_key_exists($row['source_id'], $accepted)) {
                continue;
            }
            $row['crosses_boundary'] = $accepted[$row['source_id']];
            if ($row['feature_kind'] === 'part' && ! in_array($row['raw_data']['tags']->building ?? '', ['', 'no'], true)) {
                $report['warnings'][] = ['source_id' => $row['source_id'], 'reason' => 'building_and_part_tags_part_takes_precedence'];
            }
            $selected[] = $row;
        }
        if ($selected) {
            DB::statement("INSERT INTO {$table} (osm_type,osm_id,osm_version,osm_updated_at,feature_kind,geom,crosses_boundary,parent_relations,raw_data)
                SELECT osm_type,osm_id,osm_version,osm_updated_at,feature_kind,ST_GeomFromGeoJSON(geometry),crosses_boundary,parent_relations,raw_data
                FROM jsonb_to_recordset(?::jsonb) AS x(osm_type text,osm_id bigint,osm_version integer,osm_updated_at timestamptz,
                    feature_kind text,geometry jsonb,crosses_boundary boolean,parent_relations jsonb,raw_data jsonb)", [$this->json($selected)]);
        }
    }

    private function classifyOuterMembers(string $table, array &$report): void
    {
        DB::statement("CREATE INDEX ON {$table} (osm_type,osm_id)");
        DB::statement(<<<SQL
            WITH matches AS (
                SELECT w.osm_id,jsonb_agg(DISTINCT r.osm_id ORDER BY r.osm_id) AS parents
                FROM {$table} w
                CROSS JOIN LATERAL jsonb_to_recordset(w.parent_relations) AS p(osm_id bigint,role text)
                JOIN {$table} r ON r.osm_type='relation' AND r.osm_id=p.osm_id AND r.feature_kind='building'
                WHERE w.osm_type='way' AND w.feature_kind='building' AND p.role='outer' AND ST_Covers(r.geom,w.geom)
                GROUP BY w.osm_id
            ) UPDATE {$table} w SET count_exclusion=jsonb_build_object('reason','covered_outer_member','parent_osm_ids',m.parents)
            FROM matches m WHERE w.osm_type='way' AND w.osm_id=m.osm_id
            SQL);
        $report['count_exclusions'] = array_map(fn ($row) => ['source_id' => 'way/'.$row->osm_id,
            'reason' => 'covered_outer_member', 'parent_osm_ids' => json_decode($row->parents, true)],
            DB::select("SELECT osm_id,count_exclusion->'parent_osm_ids' AS parents FROM {$table} WHERE count_exclusion IS NOT NULL ORDER BY osm_id"));
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
