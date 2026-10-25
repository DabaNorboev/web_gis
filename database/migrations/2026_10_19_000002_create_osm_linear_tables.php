<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        foreach (['osm_roads' => ['highway', "'motorway','trunk','primary','secondary'"], 'osm_railways' => ['railway', "'rail','narrow_gauge'"]] as $name => [$tag, $types]) {
            Schema::create($name, function (Blueprint $table) {
                $table->id();
                $table->foreignId('dataset_import_id')->constrained('dataset_imports')->restrictOnDelete();
                $table->string('osm_type', 8);
                $table->bigInteger('osm_id');
                $table->integer('osm_version')->nullable();
                $table->timestampTz('osm_updated_at')->nullable();
                $table->string('feature_type', 24);
                $table->text('name')->nullable();
                $table->text('ref')->nullable();
                $table->geometry('geom', subtype: 'linestring', srid: 4326);
                $table->boolean('crosses_boundary');
                $table->jsonb('raw_data');
                $table->unique(['dataset_import_id', 'osm_type', 'osm_id']);
                $table->index(['osm_type', 'osm_id']);
                $table->index(['dataset_import_id', 'feature_type']);
                $table->spatialIndex('geom');
            });
            DB::statement("ALTER TABLE {$name}
                ADD CONSTRAINT {$name}_identity_check CHECK (osm_type='way' AND osm_id>0 AND (osm_version IS NULL OR osm_version>0)),
                ADD CONSTRAINT {$name}_type_check CHECK (feature_type IN ({$types})),
                ADD CONSTRAINT {$name}_geometry_check CHECK (NOT ST_IsEmpty(geom) AND ST_IsValid(geom) AND ST_NDims(geom)=2
                    AND ST_XMin(Box3D(geom))>=-180 AND ST_XMax(Box3D(geom))<=180
                    AND ST_YMin(Box3D(geom))>=-90 AND ST_YMax(Box3D(geom))<=90),
                ADD CONSTRAINT {$name}_metadata_check CHECK (jsonb_typeof(raw_data)='object'
                    AND jsonb_typeof(raw_data->'tags') IS NOT DISTINCT FROM 'object'
                    AND feature_type IS NOT DISTINCT FROM (raw_data->'tags'->>'{$tag}'))");
            DB::statement("CREATE INDEX {$name}_geography_index ON {$name} USING gist ((geom::geography))");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('osm_railways');
        Schema::dropIfExists('osm_roads');
    }
};
