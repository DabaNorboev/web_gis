<?php

namespace Tests\Integration;

use App\Services\Addresses\PointAddressService;
use App\Services\Gis\DatasetCoverage;
use Illuminate\Support\Facades\DB;
use Tests\PostgisTestCase;

class PointAddressTest extends PostgisTestCase
{
    private int $snapshot;

    protected function setUp(): void
    {
        parent::setUp(); // Enforces web_gis_test and READ WRITE before any fixture/migration.
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        DB::table('dataset_imports')->where('source', 'OpenStreetMap')->where('dataset_key', 'addresses')->update(['is_active' => false]);
        $this->snapshot = DB::table('dataset_imports')->insertGetId([
            'source' => 'OpenStreetMap', 'dataset_key' => 'addresses', 'checksum_sha256' => str_repeat('a', 64),
            'configuration_sha256' => str_repeat('b', 64), 'configuration' => '{}', 'status' => 'succeeded',
            'is_active' => true, 'started_at' => now(), 'finished_at' => now(),
        ]);
    }

    protected function tearDown(): void
    {
        while (DB::transactionLevel() > 0) {
            DB::rollBack();
        }
        parent::tearDown();
    }

    public function test_one_containing_object_reuses_search_aliases_and_never_returns_a_replacement_point(): void
    {
        $this->object(1, 'POLYGON((92.899 55.999,92.901 55.999,92.901 56.001,92.899 56.001,92.899 55.999))');
        $this->object(2, 'POINT(92.9 56)', 'node');
        $this->prepareSearch();
        $before = DB::selectOne("SELECT md5(string_agg(to_jsonb(a)::text,'' ORDER BY id)) hash FROM osm_addresses a")->hash;
        $response = $this->postJson('/api/v1/addresses/resolve-point', ['lon' => 92.90012345678, 'lat' => 56.00012345678])
            ->assertOk()->assertJsonPath('data.match', 'CONTAINING')->assertJsonPath('data.requires_choice', false)
            ->assertJsonCount(1, 'data.candidates')->assertJsonPath('data.candidates.0.id', 'osm:way:1')
            ->assertJsonPath('data.candidates.0.distance_m', 0)->assertJsonPath('meta.observed_at', null)
            ->assertJsonPath('meta.quality.freshness', 'UNKNOWN')->assertJsonPath('meta.coverage.status', 'UNKNOWN');
        $this->assertArrayNotHasKey('lon', $response->json('data.candidates.0'));
        $this->assertArrayNotHasKey('point', $response->json());
        $this->assertSame($before, DB::selectOne("SELECT md5(string_agg(to_jsonb(a)::text,'' ORDER BY id)) hash FROM osm_addresses a")->hash);
    }

    public function test_overlapping_contours_and_a_different_address_point_require_explicit_choice(): void
    {
        $wkt = 'POLYGON((92.899 55.999,92.901 55.999,92.901 56.001,92.899 56.001,92.899 55.999))';
        $this->object(1, $wkt);
        $this->object(2, $wkt);
        $this->object(3, 'POINT(92.9 56)', 'node', '20');
        $this->prepareSearch();
        $this->postJson('/api/v1/addresses/resolve-point', ['lon' => 92.9, 'lat' => 56])
            ->assertOk()->assertJsonPath('data.match', 'CONTAINING')->assertJsonPath('data.requires_choice', true)
            ->assertJsonCount(3, 'data.candidates');
    }

    public function test_boundary_is_covered_but_a_hole_is_not_and_multipolygons_work(): void
    {
        $this->object(1, 'POLYGON((92.899 55.999,92.901 55.999,92.901 56.001,92.899 56.001,92.899 55.999),(92.8998 55.9998,92.9002 55.9998,92.9002 56.0002,92.8998 56.0002,92.8998 55.9998))');
        $this->object(2, 'MULTIPOLYGON(((92.91 56,92.911 56,92.911 56.001,92.91 56.001,92.91 56)))');
        $this->prepareSearch();
        $service = app(PointAddressService::class);
        $this->assertSame('CONTAINING', $service->resolve(92.899, 56)['data']['match']);
        $hole = $service->resolve(92.9, 56);
        $this->assertSame('NEARBY', $hole['data']['match']);
        $this->assertGreaterThan(0, $hole['data']['candidates'][0]['distance_m']);
        $this->assertSame('MULTIPOLYGON', $service->resolve(92.9105, 56.0005)['data']['candidates'][0]['geometry_type']);
    }

    public function test_nearby_distance_is_to_contour_not_building_centre_and_is_bounded(): void
    {
        $this->object(1, 'POLYGON((92.9 55.999,92.91 55.999,92.91 56.001,92.9 56.001,92.9 55.999))');
        $this->prepareSearch();
        $near = app(PointAddressService::class)->resolve(92.8999, 56);
        $this->assertSame('NEARBY', $near['data']['match']);
        $this->assertSame('PROXY', $near['meta']['quality']['method']);
        $this->assertEqualsWithDelta(6.24, $near['data']['candidates'][0]['distance_m'], .1);
        $far = app(PointAddressService::class)->resolve(92.89, 56);
        $this->assertSame('NONE', $far['data']['match']);
        $this->assertSame([], $far['data']['candidates']);
        $this->assertNull($far['meta']['quality']['method']);
        $this->assertSame('INSUFFICIENT_DATA', $far['meta']['quality']['availability']);
    }

    public function test_equal_nearby_points_do_not_pick_an_arbitrary_address(): void
    {
        $this->object(1, 'POINT(92.8999 56)', 'node');
        $this->object(2, 'POINT(92.9001 56)', 'node', '20');
        $this->prepareSearch();
        $response = app(PointAddressService::class)->resolve(92.9, 56);
        $this->assertSame('NEARBY', $response['data']['match']);
        $this->assertTrue($response['data']['requires_choice']);
        $this->assertCount(2, $response['data']['candidates']);
    }

    public function test_inactive_data_missing_snapshot_and_confirmed_outside_coverage_are_distinct(): void
    {
        $this->object(1, 'POINT(92.9 56)', 'node');
        $this->prepareSearch();
        $coverage = app(DatasetCoverage::class);
        $coverage->store($this->snapshot, $coverage->prepare('{"type":"Polygon","coordinates":[[[92.899,55.999],[92.901,55.999],[92.901,56.001],[92.899,56.001],[92.899,55.999]]]}'));
        $outside = app(PointAddressService::class)->resolve(92.9011, 56);
        $this->assertSame('NONE', $outside['data']['match']);
        $this->assertSame('OUTSIDE_SERVICE_AREA', $outside['meta']['coverage']['status']);
        DB::table('dataset_imports')->where('id', $this->snapshot)->update(['is_active' => false]);
        $missing = app(PointAddressService::class)->resolve(92.9, 56);
        $this->assertSame('UNAVAILABLE', $missing['meta']['quality']['availability']);
        $this->assertNull($missing['meta']['dataset_import_id']);
        $this->assertSame([], $missing['data']['candidates']);
    }

    private function prepareSearch(): void
    {
        DB::select('SELECT osm_address_search_rebuild(?)', [$this->snapshot]);
    }

    private function object(int $id, string $wkt, string $type = 'way', string $house = '10'): void
    {
        $tags = ['addr:street' => 'улица Тестовая', 'addr:housenumber' => $house];
        if ($type !== 'node') {
            $tags['building'] = 'yes';
        }
        DB::insert(<<<'SQL'
            INSERT INTO osm_addresses(dataset_import_id,osm_type,osm_id,street,house_number,label,source_geom,geom,point_method,raw_data)
            VALUES (?,?,?,'улица Тестовая',?,?,ST_GeomFromText(?,4326),ST_PointOnSurface(ST_GeomFromText(?,4326)),?,?::jsonb)
            SQL, [$this->snapshot, $type, $id, $house, 'улица Тестовая, '.$house, $wkt, $wkt,
            $type === 'node' ? 'osm_node' : 'point_on_surface', json_encode(['tags' => $tags])]);
    }
}
