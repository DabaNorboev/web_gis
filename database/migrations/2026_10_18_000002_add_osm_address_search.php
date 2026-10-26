<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        DB::unprepared(<<<'SQL'
            CREATE FUNCTION osm_address_normalize(value text) RETURNS text
            LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT AS $fn$
                WITH original AS (SELECT replace(lower(value), 'ё', 'е') AS v),
                avenues AS (SELECT regexp_replace(v, '\mпр-т\M', 'проспект', 'g') AS v FROM original),
                punctuation AS (SELECT regexp_replace(v, '[^[:alnum:]/ -]+', ' ', 'g') AS v FROM avenues),
                streets AS (SELECT regexp_replace(v, '\mул\M', 'улица', 'g') AS v FROM punctuation),
                prospects AS (SELECT regexp_replace(v, '\m(просп|пр)\M', 'проспект', 'g') AS v FROM streets),
                lanes AS (SELECT regexp_replace(v, '\mпер\M', 'переулок', 'g') AS v FROM prospects),
                houses AS (SELECT regexp_replace(v, '\m(д|дом)\M', '', 'g') AS v FROM lanes)
                SELECT btrim(regexp_replace(v, '\s+', ' ', 'g')) FROM houses
            $fn$;
            ALTER TABLE osm_addresses ADD COLUMN search_text text GENERATED ALWAYS AS (
                osm_address_normalize(coalesce(locality,'') || ' ' || coalesce(street,place,'') || ' ' || house_number)
            ) STORED;
            CREATE INDEX osm_addresses_search_trgm_index ON osm_addresses USING gin (search_text gin_trgm_ops);
            SQL);
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE osm_addresses DROP COLUMN search_text');
        DB::statement('DROP FUNCTION osm_address_normalize(text)');
        // The extension may be used by other sections, so rollback preserves it.
    }
};
