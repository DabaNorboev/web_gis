<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('transport_stops', function (Blueprint $table) {
            $table->id();
            $table->foreignId('dataset_import_id')->constrained('dataset_imports')->restrictOnDelete();
            $table->string('source_id');
            $table->text('name')->nullable();
            $table->text('address')->nullable();
            $table->geometry('geom', subtype: 'point', srid: 4326);
            $table->jsonb('raw_data');
            $table->unique(['dataset_import_id', 'source_id']);
            $table->unique(['id', 'dataset_import_id'], 'transport_stops_snapshot_key');
            $table->spatialIndex('geom');
        });

        DB::statement(<<<'SQL'
            ALTER TABLE transport_stops
                ADD CONSTRAINT transport_stops_source_id_check CHECK (btrim(source_id) <> ''),
                ADD CONSTRAINT transport_stops_coordinates_check
                    CHECK (NOT ST_IsEmpty(geom)
                        AND ST_X(geom) BETWEEN -180 AND 180
                        AND ST_Y(geom) BETWEEN -90 AND 90)
            SQL);

        DB::statement(<<<'SQL'
            CREATE INDEX transport_stops_geography_index
                ON transport_stops USING gist ((geom::geography))
            SQL);

        Schema::create('transport_routes', function (Blueprint $table) {
            $table->id();
            $table->foreignId('dataset_import_id')->constrained('dataset_imports')->restrictOnDelete();
            $table->string('source_id');
            $table->string('mode', 16);
            $table->string('ref', 64);
            $table->text('name')->nullable();
            $table->jsonb('raw_data');
            $table->unique(['dataset_import_id', 'source_id']);
            $table->unique(['dataset_import_id', 'mode', 'ref']);
            $table->unique(['id', 'dataset_import_id'], 'transport_routes_snapshot_key');
        });

        DB::statement(<<<'SQL'
            ALTER TABLE transport_routes
                ADD CONSTRAINT transport_routes_identity_check
                    CHECK (btrim(source_id) <> '' AND btrim(ref) <> ''),
                ADD CONSTRAINT transport_routes_mode_check
                    CHECK (mode IN ('bus', 'trolleybus', 'tram', 'unknown'))
            SQL);

        Schema::create('transport_stop_routes', function (Blueprint $table) {
            $table->unsignedBigInteger('dataset_import_id');
            $table->unsignedBigInteger('transport_stop_id');
            $table->unsignedBigInteger('transport_route_id');
            $table->primary(['transport_stop_id', 'transport_route_id']);
            $table->foreign(['transport_stop_id', 'dataset_import_id'], 'transport_stop_routes_stop_fk')
                ->references(['id', 'dataset_import_id'])->on('transport_stops')->restrictOnDelete();
            $table->foreign(['transport_route_id', 'dataset_import_id'], 'transport_stop_routes_route_fk')
                ->references(['id', 'dataset_import_id'])->on('transport_routes')->restrictOnDelete();
            $table->index(['transport_route_id', 'transport_stop_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('transport_stop_routes');
        Schema::dropIfExists('transport_routes');
        Schema::dropIfExists('transport_stops');
    }
};
