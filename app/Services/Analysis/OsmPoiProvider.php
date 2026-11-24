<?php

namespace App\Services\Analysis;

use App\Services\Gis\DatasetCoverage;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

abstract class OsmPoiProvider
{
    public function __construct(private DatasetCoverage $coverage) {}

    public function analyze(array $point, int $radius): PoiCategoryResult
    {
        $categoryKey = static::DATASET;
        $table = 'osm_'.$categoryKey;

        return DB::transaction(function () use ($point, $radius, $categoryKey, $table): PoiCategoryResult {
            if (DB::getDriverName() === 'pgsql') {
                DB::statement("SET LOCAL statement_timeout = '2s'");
                DB::statement("SET LOCAL lock_timeout = '500ms'");
            }
            $snapshot = Schema::hasTable($table) ? DB::table('dataset_imports')
                ->where('source', 'OpenStreetMap')->where('dataset_key', $categoryKey)->where('status', 'succeeded')->where('is_active', true)->first() : null;
            if (! $snapshot) {
                return PoiCategoryResult::unavailable(
                    strtoupper($categoryKey).'_SNAPSHOT_UNAVAILABLE',
                    'Подготовленный OSM-набор '.$categoryKey.' не активирован в этом окружении (А8).',
                );
            }

            $coverage = $this->coverage->assess($snapshot->id, $point['lon'], $point['lat'], $radius);
            $items = [];
            $possibleDuplicates = [];
            foreach (json_decode($snapshot->result, true)['possible_duplicates'] ?? [] as $pair) {
                $possibleDuplicates[$pair['first_id']] = true;
                $possibleDuplicates[$pair['second_id']] = true;
            }
            if ($coverage['status'] !== 'OUTSIDE_SERVICE_AREA') {
                $rows = DB::select(<<<SQL
                    WITH p AS (SELECT ST_SetSRID(ST_MakePoint(?,?),4326) AS geom)
                    SELECT g.source_id,g.name,g.address,g.access,ST_AsGeoJSON(g.geom,15) AS geometry,
                        ST_X(ST_PointOnSurface(g.geom)) AS lon,ST_Y(ST_PointOnSurface(g.geom)) AS lat,
                        ST_Distance(g.geom::geography,p.geom::geography) AS distance_m
                    FROM {$table} g CROSS JOIN p
                    WHERE g.dataset_import_id=?
                        -- Conservative indexed candidate filter, never the final analysis radius.
                        AND ST_DWithin(g.geom::geography,p.geom::geography,? + 0.001)
                        AND ST_Distance(g.geom::geography,p.geom::geography)<=?
                    ORDER BY distance_m,g.source_id
                    SQL, [$point['lon'], $point['lat'], $snapshot->id, $radius, $radius]);
                foreach ($rows as $row) {
                    $item = ['id' => $row->source_id, 'category' => $categoryKey, 'name' => $row->name, 'address' => $row->address,
                        'geometry' => json_decode($row->geometry, true), 'point' => ['lon' => (float) $row->lon, 'lat' => (float) $row->lat],
                        'identity_note' => isset($possibleDuplicates[$row->source_id]) ? static::POSSIBLE_DUPLICATE_NOTE : null,
                        'distance_m' => (float) $row->distance_m, 'access' => $row->access, 'source' => 'OpenStreetMap',
                        'dataset_import_id' => $snapshot->id, 'observed_at' => null,
                        'source_updated_at' => $snapshot->source_updated_at === null ? null : CarbonImmutable::parse($snapshot->source_updated_at)->toISOString()];
                    $items[] = $item + $this->itemMetadata($item);
                }
            }

            return PoiCategoryResult::ready($coverage, ['status' => 'UNKNOWN', 'reason' => static::COMPLETENESS_REASON], $items);
        });
    }

    protected function itemMetadata(array $item): array
    {
        return [];
    }
}
