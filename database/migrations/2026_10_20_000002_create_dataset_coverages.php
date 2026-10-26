<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::unprepared(<<<'SQL'
            CREATE TABLE dataset_coverages (
                dataset_import_id bigint PRIMARY KEY REFERENCES dataset_imports(id) ON DELETE RESTRICT,
                service_geom geometry(Geometry,4326) NOT NULL,
                data_geom geometry(Geometry,4326) NOT NULL,
                buffer_m integer NOT NULL CHECK (buffer_m BETWEEN 0 AND 5000),
                service_boundary_sha256 char(64) NOT NULL CHECK (service_boundary_sha256 ~ '^[0-9a-f]{64}$'),
                data_boundary_sha256 char(64) NOT NULL CHECK (data_boundary_sha256 ~ '^[0-9a-f]{64}$'),
                CONSTRAINT dataset_coverage_geometry_check CHECK (
                    ST_GeometryType(service_geom) IN ('ST_Polygon','ST_MultiPolygon')
                    AND ST_GeometryType(data_geom) IN ('ST_Polygon','ST_MultiPolygon')
                    AND ST_IsValid(service_geom) AND ST_IsValid(data_geom)
                    AND NOT ST_IsEmpty(service_geom) AND NOT ST_IsEmpty(data_geom)
                    AND ST_NDims(service_geom)=2 AND ST_NDims(data_geom)=2
                    AND ST_Covers(data_geom,service_geom)
                )
            );
            SQL);
    }

    public function down(): void
    {
        DB::statement('DROP TABLE dataset_coverages');
    }
};
