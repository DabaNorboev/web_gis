<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::unprepared(<<<'SQL'
            CREATE TABLE osm_grocery (
                dataset_import_id bigint NOT NULL REFERENCES dataset_imports(id),
                source_id text NOT NULL CHECK (source_id ~ '^osm:(node|way|relation):[1-9][0-9]*$'),
                name text, address text, access text,
                osm_version integer, osm_updated_at timestamptz,
                geom geometry(Geometry,4326) NOT NULL,
                raw_data jsonb NOT NULL,
                PRIMARY KEY (dataset_import_id,source_id),
                CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom) AND ST_NDims(geom)=2
                    AND ST_GeometryType(geom) IN ('ST_Point','ST_Polygon','ST_MultiPolygon'))
            );
            CREATE INDEX osm_grocery_geom_gist ON osm_grocery USING gist (geom);
            CREATE INDEX osm_grocery_geography_gist ON osm_grocery USING gist ((geom::geography));
            SQL);
    }

    public function down(): void
    {
        DB::statement('DROP TABLE osm_grocery');
    }
};
