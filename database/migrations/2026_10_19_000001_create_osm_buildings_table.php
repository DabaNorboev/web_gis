<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('osm_buildings', function (Blueprint $table) {
            $table->id();
            $table->foreignId('dataset_import_id')->constrained('dataset_imports')->restrictOnDelete();
            $table->string('osm_type', 8);
            $table->bigInteger('osm_id');
            $table->integer('osm_version')->nullable();
            $table->timestampTz('osm_updated_at')->nullable();
            $table->string('feature_kind', 16);
            $table->geometry('geom', srid: 4326);
            $table->boolean('crosses_boundary');
            $table->jsonb('parent_relations');
            $table->jsonb('count_exclusion')->nullable();
            $table->jsonb('raw_data');
            $table->unique(['dataset_import_id', 'osm_type', 'osm_id']);
            $table->index(['osm_type', 'osm_id']);
            $table->index(['dataset_import_id', 'feature_kind']);
            $table->spatialIndex('geom');
        });
        DB::statement(<<<'SQL'
            ALTER TABLE osm_buildings
                ADD CONSTRAINT osm_buildings_identity_check CHECK (
                    osm_type IN ('way','relation') AND osm_id > 0 AND (osm_version IS NULL OR osm_version > 0)),
                ADD CONSTRAINT osm_buildings_kind_check CHECK (feature_kind IN ('building','part')),
                ADD CONSTRAINT osm_buildings_geometry_check CHECK (
                    ST_GeometryType(geom) IN ('ST_Polygon','ST_MultiPolygon')
                    AND NOT ST_IsEmpty(geom) AND ST_IsValid(geom) AND ST_NDims(geom)=2
                    AND ST_XMin(Box3D(geom)) >= -180 AND ST_XMax(Box3D(geom)) <= 180
                    AND ST_YMin(Box3D(geom)) >= -90 AND ST_YMax(Box3D(geom)) <= 90),
                ADD CONSTRAINT osm_buildings_metadata_check CHECK (
                    jsonb_typeof(raw_data)='object' AND jsonb_typeof(parent_relations)='array'
                    AND jsonb_typeof(raw_data->'tags') IS NOT DISTINCT FROM 'object'),
                ADD CONSTRAINT osm_buildings_tags_check CHECK (
                    (feature_kind='part' AND coalesce(raw_data->'tags'->>'building:part','') NOT IN ('','no'))
                    OR (feature_kind='building' AND coalesce(raw_data->'tags'->>'building','') NOT IN ('','no')
                        AND coalesce(raw_data->'tags'->>'building:part','') IN ('','no'))),
                ADD CONSTRAINT osm_buildings_exclusion_check CHECK (
                    count_exclusion IS NULL OR (
                        osm_type='way' AND feature_kind='building'
                        AND jsonb_typeof(count_exclusion)='object'
                        AND count_exclusion->>'reason' IS NOT DISTINCT FROM 'covered_outer_member'
                        AND jsonb_typeof(count_exclusion->'parent_osm_ids') IS NOT DISTINCT FROM 'array'
                        AND jsonb_array_length(count_exclusion->'parent_osm_ids') > 0))
            SQL);
    }

    public function down(): void
    {
        Schema::dropIfExists('osm_buildings');
    }
};
