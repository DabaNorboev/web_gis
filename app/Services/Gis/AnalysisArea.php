<?php

namespace App\Services\Gis;

use Illuminate\Support\Facades\DB;

class AnalysisArea
{
    public function forPoint(float $lon, float $lat, int $radiusM): array
    {
        $area = DB::selectOne(<<<'SQL'
            SELECT ST_AsGeoJSON(geom) AS geometry,
                ST_XMin(Box3D(geom)) AS west, ST_YMin(Box3D(geom)) AS south,
                ST_XMax(Box3D(geom)) AS east, ST_YMax(Box3D(geom)) AS north
            FROM (SELECT ST_Buffer(ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)::geometry AS geom) AS area
            SQL, [$lon, $lat, $radiusM]);

        return ['analysis_area' => json_decode($area->geometry, true),
            'analysis_bounds' => [(float) $area->west, (float) $area->south, (float) $area->east, (float) $area->north]];
    }
}
