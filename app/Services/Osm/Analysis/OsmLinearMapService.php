<?php

namespace App\Services\Osm\Analysis;

use App\Services\Osm\Import\OsmLinearDataset;
use Illuminate\Support\Facades\DB;

/** Display-only fragments of the already selected local snapshot. No lengths or topology. */
class OsmLinearMapService
{
    public function forDataset(OsmLinearDataset $dataset, ?object $import, array $category, float $lon, float $lat, int $radiusM): array
    {
        $metric = $category['metrics']['length'];
        $result = ['type' => 'FeatureCollection', 'features' => [], 'coverage' => $category['coverage'],
            'source' => $metric['source'], 'dataset_import_id' => $metric['dataset_import_id'],
            'observed_at' => $metric['observed_at'], 'source_updated_at' => $metric['source_updated_at'],
            'quality' => array_replace($metric['quality'], ['reason' => $category['coverage']['reason']]), 'radius_m' => $radiusM];
        if (! $import || in_array($category['coverage']['status'], ['UNKNOWN', 'OUTSIDE_SERVICE_AREA'], true)) {
            return $result;
        }
        $table = $dataset->table(); // Enum-controlled identifier, never request input.
        $rows = DB::select(<<<SQL
            WITH scope AS (
                SELECT ST_Intersection(ST_Buffer(ST_Transform(ST_SetSRID(ST_MakePoint(?,?),4326),32646),?, 'quad_segs=64'),
                    ST_Transform(data_geom,32646)) geom
                FROM dataset_coverages WHERE dataset_import_id=?
            ), clipped AS (
                SELECT a.osm_id,a.name,a.feature_type,
                    ST_CollectionExtract(ST_Intersection(ST_Transform(a.geom,32646),s.geom),2) geom
                FROM {$table} a CROSS JOIN scope s
                WHERE a.dataset_import_id=? AND a.geom && ST_Transform(s.geom,4326)
            )
            SELECT osm_id,name,feature_type,ST_AsGeoJSON(ST_Transform(geom,4326),9) geometry
            FROM clipped WHERE NOT ST_IsEmpty(geom) ORDER BY osm_id
            SQL, [$lon, $lat, $radiusM, $import->id, $import->id]);
        foreach ($rows as $row) {
            $id = 'osm:way:'.$row->osm_id;
            $result['features'][] = ['type' => 'Feature', 'id' => $id,
                'properties' => ['id' => $id, 'name' => $row->name, 'feature_type' => $row->feature_type],
                'geometry' => json_decode($row->geometry, true)];
        }

        return $result;
    }
}
