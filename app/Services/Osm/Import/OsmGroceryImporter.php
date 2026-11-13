<?php

namespace App\Services\Osm\Import;

use App\Services\Gis\DatasetCoverage;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Throwable;

/** Offline snapshot activation: exact boundary, strict geometry, atomic replacement. */
class OsmGroceryImporter
{
    public function __construct(private OsmGroceryReader $reader, private DatasetCoverage $coverage, private OsmGroceryPreparation $preparation) {}

    public function import(string $file, string $boundaryFile, array $options = []): array
    {
        $dataset = $this->reader::DATASET;
        $table = 'osm_'.$dataset;
        $contents = file_get_contents($file);
        $boundaryContents = file_get_contents($boundaryFile);
        if ($contents === false || $boundaryContents === false) {
            throw new RuntimeException('Cannot read grocery input.');
        }
        $checksum = hash('sha256', $contents);
        if (isset($options['expected_sha256']) && $options['expected_sha256'] !== $checksum) {
            throw new RuntimeException('Grocery snapshot checksum mismatch.');
        }
        $document = $this->reader->read($contents);
        $coverage = $this->coverage->prepare($boundaryContents, $options['buffer_m'] ?? 0);
        $this->preparation->validate($document, $coverage);
        $this->coverage->validatePreparation($document, $coverage);
        $config = ['method_version' => $this->reader::METHOD, $this->reader::TAG => $this->reader::SHOPS,
            'coverage' => $this->coverage->metadata($coverage), 'preparation' => $document['preparation'] ?? null,
            'source_updated_at' => $document['osm3s']['timestamp_osm_base'] ?? null,
            'observed_at' => null, 'license' => 'ODbL-1.0'];
        $identity = ['source' => 'OpenStreetMap', 'dataset_key' => $dataset, 'checksum_sha256' => $checksum,
            'configuration_sha256' => hash('sha256', $this->json($config))];
        $lock = 'web_gis:OpenStreetMap:'.$dataset;
        if (! DB::selectOne('SELECT pg_try_advisory_lock(hashtextextended(?,0)) AS acquired', [$lock])->acquired) {
            throw new RuntimeException('Another grocery import is running.');
        }
        $importId = null;
        try {
            $existing = DB::table('dataset_imports')->where($identity)->where('status', 'succeeded')->first();
            if ($existing) {
                return ['status' => 'skipped', 'import_id' => $existing->id, 'report' => json_decode($existing->result, true)];
            }
            $importId = DB::table('dataset_imports')->insertGetId($identity + [
                'configuration' => $this->json($config), 'source_url' => 'https://www.openstreetmap.org/',
                'source_version' => $config['source_updated_at'], 'source_updated_at' => $config['source_updated_at'],
                'observed_at' => null, 'status' => 'running', 'started_at' => DB::raw('clock_timestamp()'),
            ]);

            return DB::transaction(function () use ($document, $coverage, $importId, $options, $dataset, $table) {
                $stage = 'grocery_stage_'.bin2hex(random_bytes(6));
                DB::statement("CREATE TEMP TABLE {$stage} (LIKE {$table} INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP");
                $rows = $this->reader->rows($document);
                $report = ['input_objects' => count($document['elements']), 'category_candidates' => count($rows), 'outside' => 0, 'duplicate_representations' => []];
                foreach ($rows as $row) {
                    $geometry = $this->json($row['geometry']);
                    $check = DB::selectOne('SELECT ST_IsValid(g) AND NOT ST_IsEmpty(g) AS valid, ST_Intersects(g,ST_GeomFromGeoJSON(?)) AS inside FROM (SELECT ST_GeomFromGeoJSON(?) g) t', [$coverage['data_geometry'], $geometry]);
                    if (! $check->valid) {
                        throw new RuntimeException('Invalid selected grocery geometry; snapshot refused.');
                    }
                    if (! $check->inside) {
                        $report['outside']++;

                        continue;
                    }
                    DB::insert("INSERT INTO {$stage} (dataset_import_id,source_id,name,address,access,osm_version,osm_updated_at,geom,raw_data)
                        VALUES (?,?,?,?,?,?,?,ST_GeomFromGeoJSON(?),?::jsonb)", [$importId, $row['source_id'], $row['name'], $row['address'], $row['access'], $row['osm_version'], $row['osm_updated_at'], $geometry, $this->json($row['raw_data'])]);
                }
                // Only structural aliases with equal full geometries AND all non-type tags.
                // Name, containment and proximity alone never establish identity.
                $aliases = $this->structuralAliases($stage);
                foreach ($aliases as $alias) {
                    $report['duplicate_representations'][] = (array) $alias;
                    DB::update("UPDATE {$stage} SET raw_data=jsonb_set(raw_data,'{aliases}',COALESCE(raw_data->'aliases','[]'::jsonb)||?::jsonb) WHERE source_id=?", [$this->json([$alias->alias]), $alias->canonical]);
                    DB::delete("DELETE FROM {$stage} WHERE source_id=?", [$alias->alias]);
                }
                $report['possible_duplicates'] = array_map(fn ($pair) => (array) $pair, DB::select("SELECT a.source_id first_id,b.source_id second_id FROM {$stage} a JOIN {$stage} b
                    ON a.source_id < b.source_id AND a.geom && b.geom AND ST_Intersects(a.geom,b.geom)
                    WHERE ST_GeometryType(a.geom)='ST_Point' OR ST_GeometryType(b.geom)='ST_Point'
                    ORDER BY a.source_id,b.source_id"));
                $count = DB::table($stage)->count();
                if ($count === 0) {
                    throw new RuntimeException('Empty grocery snapshot refused; verify source and boundary.');
                }
                $previous = DB::table('dataset_imports')->where('source', 'OpenStreetMap')->where('dataset_key', $dataset)->where('is_active', true)->first();
                if ($previous && $count < $previous->row_count * .8 && ! ($options['allow_large_drop'] ?? false)) {
                    throw new RuntimeException('Grocery count fell by more than 20 percent; explicit review required.');
                }
                $report['accepted_objects'] = $count;
                DB::statement("INSERT INTO {$table} SELECT * FROM {$stage}");
                $this->coverage->store($importId, $coverage);
                DB::table('dataset_imports')->where('source', 'OpenStreetMap')->where('dataset_key', $dataset)->where('is_active', true)->update(['is_active' => false]);
                DB::table('dataset_imports')->where('id', $importId)->update(['status' => 'succeeded', 'is_active' => true, 'finished_at' => DB::raw('clock_timestamp()'), 'row_count' => $count, 'result' => $this->json($report)]);

                return ['status' => 'succeeded', 'import_id' => $importId, 'report' => $report];
            });
        } catch (Throwable $error) {
            if ($importId !== null) {
                DB::table('dataset_imports')->where('id', $importId)->update(['status' => 'failed', 'finished_at' => DB::raw('clock_timestamp()'), 'error_message' => 'Grocery import failed: '.get_class($error)]);
            }
            throw $error;
        } finally {
            DB::selectOne('SELECT pg_advisory_unlock(hashtextextended(?,0))', [$lock]);
        }
    }

    protected function structuralAliases(string $stage): array
    {
        return DB::select("SELECT w.source_id alias,r.source_id canonical FROM {$stage} r
                    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.raw_data->'osm'->'members','[]'::jsonb)) m
                    JOIN {$stage} w ON w.source_id='osm:way:'||(m->>'ref')
                    WHERE r.source_id LIKE 'osm:relation:%' AND m->>'type'='way' AND m->>'role'='outer'
                    AND (r.raw_data->'tags')-'type'=w.raw_data->'tags' AND ST_Equals(r.geom,w.geom)
                    ORDER BY w.source_id,r.source_id");
    }

    private function json(mixed $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    }
}
