<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $rules = [
            'osm_green_areas' => ['natural' => ['wood', 'scrub', 'grassland', 'heath'], 'landuse' => ['forest', 'grass', 'meadow', 'village_green', 'orchard'], 'leisure' => ['park', 'garden']],
            'osm_water' => ['natural' => ['water'], 'waterway' => ['riverbank'], 'landuse' => ['reservoir']],
        ];
        foreach ($rules as $name => $tags) {
            Schema::create($name, function (Blueprint $table) {
                $table->id();
                $table->foreignId('dataset_import_id')->constrained('dataset_imports')->restrictOnDelete();
                $table->string('osm_type', 8);
                $table->bigInteger('osm_id');
                $table->integer('osm_version')->nullable();
                $table->timestampTz('osm_updated_at')->nullable();
                $table->string('feature_type', 64);
                $table->string('representation', 24);
                $table->text('name')->nullable();
                $table->geometry('geom', srid: 4326);
                $table->boolean('crosses_boundary');
                $table->jsonb('raw_data');
                $table->unique(['dataset_import_id', 'osm_type', 'osm_id']);
                $table->index(['osm_type', 'osm_id']);
                $table->index(['dataset_import_id', 'representation']);
                $table->spatialIndex('geom');
            });
            $checks = [];
            foreach ($tags as $tag => $values) {
                foreach ($values as $value) {
                    $representation = $name === 'osm_water' ? 'water_area' : ($tag === 'leisure' ? 'recreation_boundary' : 'vegetation_landuse');
                    $checks[] = "(feature_type='{$tag}:{$value}' AND raw_data->'tags'->>'{$tag}' IS NOT DISTINCT FROM '{$value}' AND representation='{$representation}')";
                }
            }
            $classification = implode(' OR ', $checks);
            DB::statement("ALTER TABLE {$name}
                ADD CONSTRAINT {$name}_identity_check CHECK (osm_type IN ('way','relation') AND osm_id>0 AND (osm_version IS NULL OR osm_version>0)),
                ADD CONSTRAINT {$name}_geometry_check CHECK (ST_GeometryType(geom) IN ('ST_Polygon','ST_MultiPolygon')
                    AND NOT ST_IsEmpty(geom) AND ST_IsValid(geom) AND ST_NDims(geom)=2
                    AND ST_XMin(Box3D(geom))>=-180 AND ST_XMax(Box3D(geom))<=180
                    AND ST_YMin(Box3D(geom))>=-90 AND ST_YMax(Box3D(geom))<=90),
                ADD CONSTRAINT {$name}_metadata_check CHECK (jsonb_typeof(raw_data)='object'
                    AND jsonb_typeof(raw_data->'tags') IS NOT DISTINCT FROM 'object'),
                ADD CONSTRAINT {$name}_classification_check CHECK ({$classification})");
            DB::statement("CREATE INDEX {$name}_geography_index ON {$name} USING gist ((geom::geography))");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('osm_water');
        Schema::dropIfExists('osm_green_areas');
    }
};
