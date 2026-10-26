<?php

namespace Tests\Integration;

use App\Services\Osm\Import\OsmAddressImporter;
use App\Services\Osm\Search\AddressSearchService;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class AddressSearchTest extends TestCase
{
    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || DB::connection()->getDatabaseName() !== 'web_gis_test') {
            throw new RuntimeException('Address search tests require web_gis_test.');
        }
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        $this->directory = sys_get_temp_dir().'/web-gis-search-'.bin2hex(random_bytes(8));
        mkdir($this->directory);
        file_put_contents($this->directory.'/boundary.json', '{"type":"Polygon","coordinates":[[[92,55],[94,55],[94,57],[92,57],[92,55]]]}');
    }

    protected function tearDown(): void
    {
        while (DB::transactionLevel() > 0) {
            DB::rollBack();
        }
        foreach (glob($this->directory.'/*') as $file) {
            unlink($file);
        }
        rmdir($this->directory);
        parent::tearDown();
    }

    public function test_normalization_house_number_and_stable_identity(): void
    {
        $result = $this->import([
            $this->node(1), $this->node(2, ['addr:housenumber' => '100']), $this->node(3, ['addr:housenumber' => '10А']),
            $this->node(4, ['addr:street' => 'улица Мира']),
        ]);
        $response = $this->search('ПР-Т МИРА, д. 10')->assertOk()->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.objects.0.id', 'osm:node:1')->assertJsonPath('data.0.objects.0.lon', 92.9)->assertJsonPath('data.0.objects.0.lat', 56)
            ->assertJsonPath('data.0.match_type', 'exact')->assertJsonPath('meta.dataset_import_id', $result['import_id'])
            ->assertJsonPath('meta.observed_at', null)->assertJsonPath('meta.quality.freshness', 'UNKNOWN');
        $this->assertSame('проспект Мира, 10', $response->json('data.0.label'));
        $groups = $this->search('Мира 10')->assertOk()->json('data');
        $this->assertCount(2, $groups);
        $ids = array_column(array_merge(...array_column($groups, 'objects')), 'id');
        $this->assertContains('osm:node:1', $ids);
        $this->assertContains('osm:node:4', $ids);
        $this->assertNotContains('osm:node:2', $ids);
        $this->assertNotContains('osm:node:3', $ids);
    }

    public function test_yo_slashes_prefix_and_typo_are_supported_without_changing_labels(): void
    {
        $this->import([$this->node(1, ['addr:street' => 'улица Берёзовая', 'addr:housenumber' => '10/2А']), $this->node(2, ['addr:street' => 'улица Ленина'])]);
        $this->search('ул. Березовая 10/2а')->assertOk()->assertJsonPath('data.0.label', 'улица Берёзовая, 10/2А');
        $this->search('Березов')->assertOk()->assertJsonPath('data.0.objects.0.id', 'osm:node:1');
        $this->search('Леннина 10')->assertOk()->assertJsonPath('data.0.objects.0.id', 'osm:node:2')->assertJsonPath('data.0.match_type', 'approximate');
    }

    public function test_only_contained_matching_points_are_hidden_and_distinct_buildings_remain(): void
    {
        $tags = $this->node(1)['tags'] + ['building' => 'yes', 'addr:city' => 'Красноярск'];
        $building = ['type' => 'way', 'id' => 10, 'tags' => $tags, 'geometry' => array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], [[92.89, 55.99], [92.91, 55.99], [92.91, 56.01], [92.89, 56.01], [92.89, 55.99]])];
        $other = $building;
        $other['id'] = 11;
        foreach ($other['geometry'] as &$p) {
            $p['lon'] += 0.1;
        }
        unset($p);
        $this->import([$this->node(1), array_replace($this->node(2, ['addr:city' => 'Красноярск']), ['lon' => 92.92]), $this->node(3, ['addr:city' => 'Солонцы']), $building, $other]);
        $groups = $this->search('Мира 10')->assertOk()->json('data');
        $this->assertCount(2, $groups);
        $ids = array_column(array_merge(...array_column($groups, 'objects')), 'id');
        $this->assertNotContains('osm:node:1', $ids);
        foreach (['osm:node:2', 'osm:node:3', 'osm:way:10', 'osm:way:11'] as $id) {
            $this->assertContains($id, $ids);
        }
    }

    public function test_contained_point_with_city_is_a_search_alias_for_building_without_city(): void
    {
        $building = ['type' => 'way', 'id' => 10, 'tags' => $this->node(1)['tags'] + ['building' => 'yes'],
            'geometry' => array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], [[92.89, 55.99], [92.91, 55.99], [92.91, 56.01], [92.89, 56.01], [92.89, 55.99]])];
        $this->import([$this->node(1, ['addr:city' => 'Красноярск']), $building]);
        foreach (['Мира 10', 'Красноярск Мира 10'] as $query) {
            $this->search($query)->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.object_count', 1)
                ->assertJsonPath('data.0.objects.0.id', 'osm:way:10')
                ->assertJsonPath('data.0.objects.0.geometry.type', 'Polygon');
        }
        $this->assertNull(DB::table('osm_addresses')->where('osm_type', 'way')->where('osm_id', 10)->value('locality'));
        $this->assertSame(2, DB::table('osm_addresses')->count());

        $this->import([$this->node(1, ['addr:city' => 'Красноярск']), $this->node(2, ['addr:city' => 'Солонцы']), $building]);
        $this->search('Красноярск Мира 10')->assertOk()->assertJsonPath('data.0.objects.0.id', 'osm:node:1');
        $this->search('Солонцы Мира 10')->assertOk()->assertJsonPath('data.0.objects.0.id', 'osm:node:2');

        // Two overlapping candidates do not justify choosing either building for the point.
        $other = $building;
        $other['id'] = 11;
        $this->import([$this->node(1, ['addr:city' => 'Красноярск']), $building, $other]);
        $this->search('Красноярск Мира 10')->assertOk()->assertJsonPath('data.0.objects.0.id', 'osm:node:1');
    }

    public function test_address_groups_include_all_members_before_the_ten_result_limit(): void
    {
        $nodes = [];
        for ($i = 1; $i <= 13; $i++) {
            $nodes[] = array_replace($this->node($i), ['lon' => 92.9 + $i * 0.0001]);
        }
        $this->import($nodes);
        $response = $this->search('Мира 10')->assertOk()->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.object_count', 13)->assertJsonCount(13, 'data.0.objects');
        $group = $response->json('data.0');
        $this->assertStringStartsWith('address:', $group['id']);
        $this->assertSame($group['id'], $this->search('пр-т Мира 10')->json('data.0.id'));
        $this->assertSame('Point', $group['objects'][0]['geometry']['type']);
        $this->assertEqualsWithDelta(92.9001, $group['bounds'][0], 0.000001);
        $this->assertEqualsWithDelta(92.9013, $group['bounds'][2], 0.000001);
        $this->assertSame(13, DB::table('osm_addresses')->where('dataset_import_id', $response->json('meta.dataset_import_id'))->count());
    }

    public function test_search_reads_only_active_snapshot_and_limits_results(): void
    {
        $first = $this->import([$this->node(1, ['addr:street' => 'улица Историческая'])]);
        $nodes = [];
        for ($i = 2; $i < 18; $i++) {
            $nodes[] = $this->node($i, ['addr:housenumber' => (string) $i]);
        }
        $second = $this->import($nodes);
        $this->search('Историческая')->assertOk()->assertJsonCount(0, 'data');
        $this->search('Мира')->assertOk()->assertJsonCount(10, 'data')->assertJsonPath('meta.dataset_import_id', $second['import_id']);
        $this->assertFalse(DB::table('dataset_imports')->find($first['import_id'])->is_active);
    }

    public function test_unavailable_dataset_differs_from_empty_result(): void
    {
        $this->import([$this->node(1)]);
        $this->search('Несуществующий адрес 999')->assertOk()->assertJsonPath('data', [])->assertJsonPath('meta.quality.availability', 'AVAILABLE');
        DB::table('dataset_imports')->where('source', OsmAddressImporter::SOURCE)->where('dataset_key', OsmAddressImporter::DATASET)->update(['is_active' => false]);
        $this->search('Мира 10')->assertOk()->assertJsonPath('data', [])->assertJsonPath('meta.dataset_import_id', null)->assertJsonPath('meta.quality.availability', 'UNAVAILABLE');
    }

    public function test_invalid_and_non_address_queries_do_not_expose_all_rows(): void
    {
        $this->import([$this->node(1)]);
        foreach (['', 'ab', str_repeat('я', 161), null, ['Мира']] as $value) {
            $this->getJson('/api/v1/addresses/search?'.http_build_query(['q' => $value]))->assertUnprocessable();
        }
        $this->search('%%%')->assertOk()->assertJsonPath('data', []);
    }

    public function test_generated_text_index_and_search_migration_rollback_in_test_schema(): void
    {
        DB::statement('CREATE SCHEMA address_search_migration_test');
        DB::statement('SET LOCAL search_path TO address_search_migration_test, public');
        DB::statement('CREATE TABLE address_search_migration_test.dataset_imports (id bigint PRIMARY KEY)');
        $base = require database_path('migrations/2026_10_18_000001_create_osm_addresses_table.php');
        $search = require database_path('migrations/2026_10_18_000002_add_osm_address_search.php');
        $base->up();
        $search->up();
        $index = DB::selectOne("SELECT indexdef FROM pg_indexes WHERE schemaname='address_search_migration_test' AND indexname='osm_addresses_search_trgm_index'");
        $this->assertStringContainsString('gin', $index->indexdef);
        $this->assertSame('улица березовая 10', DB::selectOne("SELECT osm_address_normalize('УЛ. БЕРЁЗОВАЯ, дом 10') AS q")->q);
        $search->down();
        $search->up();
        $this->assertNotNull(DB::selectOne("SELECT to_regclass('address_search_migration_test.osm_addresses_search_trgm_index') AS n")->n);
        $search->down();
        $base->down();
        $this->assertNotNull(DB::selectOne("SELECT extname FROM pg_extension WHERE extname='pg_trgm'"));
    }

    public function test_city_is_a_context_for_unknown_locality_and_aliases_without_rewriting_sources(): void
    {
        $result = $this->import([
            $this->node(1), $this->node(2, ['addr:city' => 'Солонцы']),
            $this->node(3, ['addr:city' => 'Красноярск']), $this->node(4, ['addr:city' => 'Krasnoyarsk']),
            $this->node(5, ['addr:city' => 'г. Красноярск']),
        ]);
        $before = DB::selectOne('SELECT md5(string_agg(to_jsonb(a)::text,\'\' ORDER BY id)) hash FROM osm_addresses a WHERE dataset_import_id=?', [$result['import_id']])->hash;
        foreach (['Красноярск Мира 10', 'г. Красноярск, пр-т Мира, 10', 'город Красноярск Мира 10',
            'Krasnoyarsk Мира 10', 'Мира 10, Красноярск', 'Красноярск Мира 10 Красноярск'] as $query) {
            $response = $this->search($query)->assertOk()->assertJsonCount(2, 'data');
            $ids = array_column(array_merge(...array_column($response->json('data'), 'objects')), 'id');
            sort($ids);
            $this->assertSame(['osm:node:1', 'osm:node:3', 'osm:node:4', 'osm:node:5'], $ids, $query);
            $this->assertStringContainsString('принадлежность городу не подтверждена', $response->json('meta.quality.reason'));
        }
        $this->search('Солонцы Мира 10')->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.objects.0.id', 'osm:node:2');
        $this->search('Красноярск Солонцы Мира 10')->assertOk()->assertJsonCount(0, 'data');
        $this->search('Красноярск')->assertOk()->assertJsonCount(0, 'data');
        $after = DB::selectOne('SELECT md5(string_agg(to_jsonb(a)::text,\'\' ORDER BY id)) hash FROM osm_addresses a WHERE dataset_import_id=?', [$result['import_id']])->hash;
        $this->assertSame($before, $after);
        $this->assertNull(DB::table('osm_addresses')->where('dataset_import_id', $result['import_id'])->where('osm_id', 1)->value('locality'));
    }

    public function test_city_word_does_not_consume_a_street_prefix_or_exact_house_number(): void
    {
        $this->import([$this->node(1, ['addr:street' => 'Красноярская улица']),
            $this->node(2, ['addr:street' => 'Красноярская улица', 'addr:housenumber' => '100']),
            $this->node(3, ['addr:street' => 'Красноярская улица', 'addr:housenumber' => '10А'])]);
        $this->search('Красноярск Красноярская 10')->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.objects.0.id', 'osm:node:1');
    }

    public function test_requests_use_prepared_aliases_without_spatial_matching_or_rebuilding(): void
    {
        $this->import([$this->node(1)]);
        DB::flushQueryLog();
        DB::enableQueryLog();
        try {
            $this->assertCount(1, app(AddressSearchService::class)->search('Красноярск Мира 10')['data']);
            $queries = implode("\n", array_column(DB::getQueryLog(), 'query'));
        } finally {
            DB::disableQueryLog();
            DB::flushQueryLog();
        }
        $this->assertStringContainsString('osm_address_search_entries', $queries);
        $this->assertDoesNotMatchRegularExpression('/ST_Covers|ST_Intersects|LATERAL|osm_address_search_rebuild|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i', $queries);
    }

    public function test_failed_search_preparation_rolls_back_publication_and_keeps_previous_searchable(): void
    {
        $first = $this->import([$this->node(1)]);
        DB::unprepared("CREATE FUNCTION pg_temp.reject_search_entry() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''test search preparation failure''; END';
            CREATE TRIGGER reject_search_entry BEFORE INSERT ON osm_address_search_entries FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_search_entry()");
        try {
            $this->import([$this->node(2)]);
            $this->fail('Expected search preparation to reject publication');
        } catch (QueryException $error) {
            $this->assertStringContainsString('test search preparation failure', $error->getMessage());
        }
        DB::statement('DROP TRIGGER reject_search_entry ON osm_address_search_entries');
        $this->assertTrue(DB::table('dataset_imports')->find($first['import_id'])->is_active);
        $this->assertSame(1, DB::table('dataset_imports')->where('source', 'OpenStreetMap')->where('dataset_key', 'addresses')->where('status', 'failed')->count());
        $this->assertSame(1, DB::table('osm_address_search_entries')->count());
        $this->search('Красноярск Мира 10')->assertOk()->assertJsonPath('data.0.objects.0.id', 'osm:node:1');
        $this->import([$this->node(2)]);
        $this->search('Красноярск Мира 10')->assertOk()->assertJsonPath('data.0.objects.0.id', 'osm:node:2');
    }

    public function test_projection_backfills_existing_rows_and_rolls_back_only_derived_data_in_test_schema(): void
    {
        $result = $this->import([$this->node(1)]);
        DB::statement('CREATE SCHEMA address_projection_migration_test');
        DB::statement('SET LOCAL search_path TO address_projection_migration_test, public');
        DB::statement('CREATE TABLE dataset_imports (LIKE public.dataset_imports INCLUDING ALL)');
        DB::statement('INSERT INTO dataset_imports SELECT * FROM public.dataset_imports WHERE id=?', [$result['import_id']]);
        $base = require database_path('migrations/2026_10_18_000001_create_osm_addresses_table.php');
        $search = require database_path('migrations/2026_10_18_000002_add_osm_address_search.php');
        $projection = require database_path('migrations/2026_10_20_000001_prepare_osm_address_search.php');
        $base->up();
        $search->up();
        $columns = 'id,dataset_import_id,osm_type,osm_id,osm_version,osm_updated_at,street,place,house_number,locality,postcode,label,source_geom,geom,point_method,raw_data';
        DB::statement("INSERT INTO osm_addresses ({$columns}) SELECT {$columns} FROM public.osm_addresses WHERE dataset_import_id=?", [$result['import_id']]);
        $projection->up();
        $this->assertSame(1, DB::table('address_projection_migration_test.osm_address_search_entries')->count());
        $this->search('Красноярск Мира 10')->assertOk()->assertJsonPath('data.0.objects.0.id', 'osm:node:1');
        $this->assertNotNull(DB::selectOne("SELECT indexname FROM pg_indexes WHERE schemaname='address_projection_migration_test' AND indexname='osm_search_text_trgm'"));
        $projection->down();
        $this->assertNull(DB::selectOne("SELECT to_regclass('address_projection_migration_test.osm_address_search_entries') AS n")->n);
        $this->assertSame(1, DB::table('address_projection_migration_test.osm_addresses')->count());
        $this->assertSame(1, DB::table('public.osm_address_search_entries')->count());
        $projection->up();
        $this->search('Красноярск Мира 10')->assertOk()->assertJsonPath('data.0.objects.0.id', 'osm:node:1');
    }

    private function search(string $query)
    {
        return $this->getJson('/api/v1/addresses/search?'.http_build_query(['q' => $query]));
    }

    private function import(array $elements): array
    {
        file_put_contents($this->directory.'/addresses.json', json_encode(['elements' => $elements], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));

        return app(OsmAddressImporter::class)->import($this->directory.'/addresses.json', $this->directory.'/boundary.json');
    }

    private function node(int $id, array $tags = []): array
    {
        return ['type' => 'node', 'id' => $id, 'lon' => 92.9, 'lat' => 56.0, 'tags' => array_replace(['addr:street' => 'проспект Мира', 'addr:housenumber' => '10'], $tags)];
    }
}
