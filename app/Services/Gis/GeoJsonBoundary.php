<?php

namespace App\Services\Gis;

use Illuminate\Support\Facades\DB;
use RuntimeException;

class GeoJsonBoundary
{
    public function geometry(string $contents): string
    {
        $json = json_decode($contents, true, flags: JSON_THROW_ON_ERROR);
        if (isset($json['crs'])) {
            throw new RuntimeException('Use standard longitude/latitude GeoJSON without a custom CRS.');
        }
        if (($json['type'] ?? null) === 'FeatureCollection') {
            if (count($json['features'] ?? []) !== 1) {
                throw new RuntimeException('Boundary must contain exactly one polygon feature.');
            }
            $json = $json['features'][0];
            if (isset($json['crs'])) {
                throw new RuntimeException('Custom CRS is not supported.');
            }
        }
        if (($json['type'] ?? null) === 'Feature') {
            $json = $json['geometry'];
        }
        if (! in_array($json['type'] ?? null, ['Polygon', 'MultiPolygon'], true)) {
            throw new RuntimeException('Boundary must be a GeoJSON Polygon or MultiPolygon in EPSG:4326.');
        }
        if (isset($json['crs'])) {
            throw new RuntimeException('Use standard longitude/latitude GeoJSON without a custom CRS.');
        }
        $geometry = json_encode($json, JSON_THROW_ON_ERROR);
        $check = DB::selectOne(<<<'SQL'
            WITH b AS (SELECT ST_GeomFromGeoJSON(?) AS geom)
            SELECT ST_IsValid(geom) AND NOT ST_IsEmpty(geom) AND ST_SRID(geom) = 4326
                AND ST_NDims(geom) = 2
                AND ST_XMin(Box3D(geom)) >= -180 AND ST_XMax(Box3D(geom)) <= 180
                AND ST_YMin(Box3D(geom)) >= -90 AND ST_YMax(Box3D(geom)) <= 90 AS valid
            FROM b
            SQL, [$geometry]);
        if (! $check->valid) {
            throw new RuntimeException('Boundary is invalid, empty or not a two-dimensional WGS84 polygon.');
        }

        return $geometry;
    }

    public function select(array $rows, string $geometry): array
    {
        $points = array_map(fn (array $r) => ['source_id' => $r['source_id'], 'lon' => $r['lon'], 'lat' => $r['lat']], $rows);
        $matches = DB::select(<<<'SQL'
            SELECT p.source_id
            FROM jsonb_to_recordset(?::jsonb) AS p(source_id text, lon double precision, lat double precision)
            WHERE ST_Covers(ST_GeomFromGeoJSON(?), ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326))
            SQL, [json_encode($points, JSON_THROW_ON_ERROR), $geometry]);
        $inside = array_fill_keys(array_column($matches, 'source_id'), true);

        return array_values(array_filter($rows, fn (array $r) => isset($inside[$r['source_id']])));
    }
}
