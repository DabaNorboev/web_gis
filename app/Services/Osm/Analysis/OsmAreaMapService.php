<?php

namespace App\Services\Osm\Analysis;

use Illuminate\Support\Facades\DB;

/** Bounded display geometry from the same snapshot as the existing metrics. */
class OsmAreaMapService
{
    public function forKind(OsmAreaKind $kind, ?object $import, array $category, float $lon, float $lat, int $radiusM): array
    {
        $metric = $category['metrics']['area'];
        $result = ['type' => 'FeatureCollection', 'features' => [], 'coverage' => $category['coverage'],
            'source' => $metric['source'], 'dataset_import_id' => $metric['dataset_import_id'],
            'observed_at' => $metric['observed_at'], 'source_updated_at' => $metric['source_updated_at'],
            'quality' => $metric['quality'], 'radius_m' => $radiusM];
        if (! $import || in_array($category['coverage']['status'], ['UNKNOWN', 'OUTSIDE_SERVICE_AREA'], true)) {
            return $result;
        }
        $table = $kind->table();
        $predicate = $kind->predicate();
        // The indexed bounding-box filter runs before per-object clipping. No union or deduplication:
        // one OSM object can independently belong to both parks and vegetation.
        $rows = DB::select(<<<SQL
            WITH scope AS (
                SELECT ST_Intersection(ST_Buffer(ST_Transform(ST_SetSRID(ST_MakePoint(?,?),4326),32646),?, 'quad_segs=64'),
                    ST_Transform(data_geom,32646)) geom
                FROM dataset_coverages WHERE dataset_import_id=?
            ), clipped AS (
                SELECT a.osm_type,a.osm_id,a.name,
                    ST_CollectionExtract(ST_Intersection(ST_Transform(a.geom,32646),s.geom),3) geom
                FROM {$table} a CROSS JOIN scope s
                WHERE a.dataset_import_id=? AND {$predicate} AND a.geom && ST_Transform(s.geom,4326)
            )
            SELECT osm_type,osm_id,name,ST_AsGeoJSON(ST_Transform(geom,4326),9) geometry
            FROM clipped WHERE NOT ST_IsEmpty(geom) ORDER BY osm_type,osm_id
            SQL, [$lon, $lat, $radiusM, $import->id, $import->id]);
        foreach ($rows as $row) {
            $id = 'osm:'.$row->osm_type.':'.$row->osm_id;
            $result['features'][] = ['type' => 'Feature', 'id' => $id,
                'properties' => ['id' => $id, 'name' => $row->name], 'geometry' => json_decode($row->geometry, true)];
        }

        return $result;
    }
}
