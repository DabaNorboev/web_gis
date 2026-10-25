<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // Share the import lock: backfill cannot race with publication of an address snapshot.
        DB::statement("SELECT pg_advisory_xact_lock(hashtextextended('web_gis:OpenStreetMap:addresses',0))");
        DB::unprepared(<<<'SQL'
            CREATE FUNCTION osm_address_locality_key(value text) RETURNS text
            LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
                WITH n AS (SELECT regexp_replace(osm_address_normalize(coalesce(value,'')), '^(г|город)\s+', '') AS v)
                SELECT CASE WHEN v IN ('красноярск','krasnoyarsk') THEN 'красноярск' ELSE v END FROM n
            $fn$;

            ALTER TABLE osm_addresses ADD CONSTRAINT osm_addresses_id_snapshot_unique UNIQUE (id,dataset_import_id);
            CREATE TABLE osm_address_search_entries (
                address_id bigint PRIMARY KEY,
                dataset_import_id bigint NOT NULL REFERENCES dataset_imports(id) ON DELETE RESTRICT,
                object_id bigint NOT NULL,
                group_key text NOT NULL,
                alias_label text NOT NULL,
                search_text text NOT NULL,
                house_key text NOT NULL,
                locality_key text NOT NULL,
                CONSTRAINT osm_search_alias_snapshot_fk FOREIGN KEY (address_id,dataset_import_id)
                    REFERENCES osm_addresses(id,dataset_import_id) ON DELETE RESTRICT,
                CONSTRAINT osm_search_object_snapshot_fk FOREIGN KEY (object_id,dataset_import_id)
                    REFERENCES osm_addresses(id,dataset_import_id) ON DELETE RESTRICT
            );
            CREATE INDEX osm_search_text_trgm ON osm_address_search_entries USING gin (search_text gin_trgm_ops);
            CREATE INDEX osm_search_snapshot_house ON osm_address_search_entries (dataset_import_id,house_key);
            CREATE INDEX osm_search_snapshot_group ON osm_address_search_entries (dataset_import_id,group_key);
            CREATE INDEX osm_search_object_snapshot ON osm_address_search_entries (object_id,dataset_import_id);

            CREATE FUNCTION osm_address_search_rebuild(import_id bigint) RETURNS bigint
            LANGUAGE plpgsql AS $fn$
            DECLARE prepared bigint;
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM dataset_imports WHERE id=import_id
                    AND source='OpenStreetMap' AND dataset_key='addresses' AND status IN ('running','succeeded')) THEN
                    RAISE EXCEPTION 'Expected an OSM address snapshot';
                END IF;
                DELETE FROM osm_address_search_entries WHERE dataset_import_id=import_id;
                INSERT INTO osm_address_search_entries
                    (address_id,dataset_import_id,object_id,group_key,alias_label,search_text,house_key,locality_key)
                SELECT original.id,original.dataset_import_id,a.id,
                    jsonb_build_array(osm_address_locality_key(a.locality),
                        osm_address_normalize(coalesce(a.street,'')),osm_address_normalize(coalesce(a.place,'')),
                        osm_address_normalize(a.house_number))::text,
                    original.label,original.search_text,osm_address_normalize(a.house_number),
                    coalesce(nullif(osm_address_locality_key(original.locality),''),osm_address_locality_key(a.locality))
                FROM osm_addresses original
                LEFT JOIN LATERAL (
                    SELECT CASE WHEN count(*)=1 THEN min(b.id) END AS id
                    FROM osm_addresses b
                    WHERE original.osm_type='node' AND b.dataset_import_id=original.dataset_import_id
                        AND b.osm_type IN ('way','relation')
                        AND coalesce(b.raw_data->'tags'->>'building','') NOT IN ('','no')
                        AND osm_address_normalize(coalesce(b.street,b.place,''))=osm_address_normalize(coalesce(original.street,original.place,''))
                        AND osm_address_normalize(b.house_number)=osm_address_normalize(original.house_number)
                        AND (osm_address_locality_key(b.locality)='' OR osm_address_locality_key(original.locality)=''
                            OR osm_address_locality_key(b.locality)=osm_address_locality_key(original.locality))
                        AND ST_Covers(b.source_geom,original.geom)
                        AND NOT EXISTS (
                            SELECT 1 FROM osm_addresses peer
                            WHERE osm_address_locality_key(b.locality)=''
                                AND osm_address_locality_key(original.locality)<>''
                                AND peer.dataset_import_id=b.dataset_import_id AND peer.osm_type='node'
                                AND osm_address_locality_key(peer.locality)<>''
                                AND osm_address_locality_key(peer.locality)<>osm_address_locality_key(original.locality)
                                AND osm_address_normalize(coalesce(peer.street,peer.place,''))=osm_address_normalize(coalesce(b.street,b.place,''))
                                AND osm_address_normalize(peer.house_number)=osm_address_normalize(b.house_number)
                                AND ST_Covers(b.source_geom,peer.geom)
                        )
                ) canonical ON true
                JOIN osm_addresses a ON a.id=coalesce(canonical.id,original.id)
                WHERE original.dataset_import_id=import_id;
                GET DIAGNOSTICS prepared=ROW_COUNT;
                RETURN prepared;
            END
            $fn$;

            SELECT osm_address_search_rebuild(id) FROM dataset_imports
                WHERE source='OpenStreetMap' AND dataset_key='addresses' AND status='succeeded';
            ANALYZE osm_address_search_entries;
            SQL);
    }

    public function down(): void
    {
        DB::statement("SELECT pg_advisory_xact_lock(hashtextextended('web_gis:OpenStreetMap:addresses',0))");
        DB::unprepared(<<<'SQL'
            DROP FUNCTION osm_address_search_rebuild(bigint);
            DROP TABLE osm_address_search_entries;
            ALTER TABLE osm_addresses DROP CONSTRAINT osm_addresses_id_snapshot_unique;
            DROP FUNCTION osm_address_locality_key(text);
            SQL);
    }
};
