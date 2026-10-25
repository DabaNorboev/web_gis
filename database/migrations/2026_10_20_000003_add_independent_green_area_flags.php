<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement("SELECT pg_advisory_xact_lock(hashtextextended('web_gis:OpenStreetMap:green_areas',0))");
        // Keep original rows and the primary import tag; semantic dimensions can overlap.
        DB::unprepared(<<<'SQL'
            ALTER TABLE osm_green_areas
                ADD COLUMN is_park boolean GENERATED ALWAYS AS
                    (coalesce(raw_data->'tags'->>'leisure','')='park') STORED,
                ADD COLUMN is_garden boolean GENERATED ALWAYS AS
                    (coalesce(raw_data->'tags'->>'leisure','')='garden') STORED,
                ADD COLUMN is_vegetation boolean GENERATED ALWAYS AS
                    (coalesce(raw_data->'tags'->>'natural','') IN ('wood','scrub','grassland','heath')
                     OR coalesce(raw_data->'tags'->>'landuse','') IN ('forest','grass','meadow','village_green','orchard')) STORED;
            ANALYZE osm_green_areas;
            SQL);
    }

    public function down(): void
    {
        DB::statement("SELECT pg_advisory_xact_lock(hashtextextended('web_gis:OpenStreetMap:green_areas',0))");
        DB::statement('ALTER TABLE osm_green_areas DROP COLUMN is_park, DROP COLUMN is_garden, DROP COLUMN is_vegetation');
    }
};
