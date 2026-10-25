<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('osm_addresses', function (Blueprint $table) {
            $table->id();
            $table->foreignId('dataset_import_id')->constrained('dataset_imports')->restrictOnDelete();
            $table->string('osm_type', 8);
            $table->bigInteger('osm_id');
            $table->integer('osm_version')->nullable();
            $table->timestampTz('osm_updated_at')->nullable();
            $table->text('street')->nullable();
            $table->text('place')->nullable();
            $table->text('house_number');
            $table->text('locality')->nullable();
            $table->text('postcode')->nullable();
            $table->text('label');
            $table->geometry('source_geom', srid: 4326);
            $table->geometry('geom', subtype: 'point', srid: 4326);
            $table->string('point_method', 24);
            $table->jsonb('raw_data');
            $table->unique(['dataset_import_id', 'osm_type', 'osm_id']);
            $table->index(['osm_type', 'osm_id']);
            $table->spatialIndex('source_geom');
            $table->spatialIndex('geom');
        });
        DB::statement(<<<'SQL'
            ALTER TABLE osm_addresses
                ADD CONSTRAINT osm_addresses_identity_check CHECK (
                    osm_type IN ('node','way','relation') AND osm_id > 0
                    AND (osm_version IS NULL OR osm_version > 0)),
                ADD CONSTRAINT osm_addresses_parts_check CHECK (
                    btrim(house_number) <> '' AND btrim(label) <> ''
                    AND (coalesce(btrim(street),'') <> '' OR coalesce(btrim(place),'') <> '')),
                ADD CONSTRAINT osm_addresses_geometry_check CHECK (
                    ST_GeometryType(source_geom) IN ('ST_Point','ST_Polygon','ST_MultiPolygon')
                    AND NOT ST_IsEmpty(source_geom) AND ST_IsValid(source_geom)
                    AND ST_NDims(source_geom) = 2 AND NOT ST_IsEmpty(geom)
                    AND ST_Covers(source_geom,geom)
                    AND ST_XMin(Box3D(source_geom)) >= -180 AND ST_XMax(Box3D(source_geom)) <= 180
                    AND ST_YMin(Box3D(source_geom)) >= -90 AND ST_YMax(Box3D(source_geom)) <= 90),
                ADD CONSTRAINT osm_addresses_point_method_check CHECK (
                    (osm_type = 'node' AND point_method = 'osm_node' AND ST_GeometryType(source_geom) = 'ST_Point' AND ST_Equals(source_geom,geom))
                    OR (osm_type IN ('way','relation') AND point_method = 'point_on_surface' AND ST_GeometryType(source_geom) IN ('ST_Polygon','ST_MultiPolygon'))),
                ADD CONSTRAINT osm_addresses_raw_data_check CHECK (jsonb_typeof(raw_data) = 'object')
            SQL);
        DB::statement('CREATE INDEX osm_addresses_geography_index ON osm_addresses USING gist ((geom::geography))');
    }

    public function down(): void
    {
        Schema::dropIfExists('osm_addresses');
    }
};
