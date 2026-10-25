<?php

namespace Tests\Integration;

use App\Services\Osm\Analysis\OsmAreaAnalysisService;
use App\Services\Osm\Analysis\OsmAreaKind;
use App\Services\Osm\Import\OsmAddressImporter;
use App\Services\Osm\Import\OsmAreaDataset;
use App\Services\Osm\Import\OsmAreaImporter;
use App\Services\Osm\Import\OsmLinearDataset;
use App\Services\Osm\Import\OsmLinearImporter;
use App\Services\Transport\Import\OfficialStopsImporter;
use App\Services\Transport\TransportAnalysisService;
use Illuminate\Support\Facades\DB;
use Mockery;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class AddressProfileTest extends TestCase
{
    private string $directory;

    private array $imports;

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || DB::connection()->getDatabaseName() !== 'web_gis_test') {
            throw new RuntimeException('Profile tests require web_gis_test.');
        }
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        $this->directory = sys_get_temp_dir().'/web-gis-profile-'.bin2hex(random_bytes(8));
        mkdir($this->directory);
        file_put_contents($this->directory.'/boundary.json', '{"type":"Polygon","coordinates":[[[92,55],[94,55],[94,57],[92,57],[92,55]]]}');
        $this->imports = ['addresses' => $this->addresses([1, 2])['import_id']];
        $polygon = ['type' => 'way', 'id' => 101, 'tags' => ['natural' => 'wood', 'leisure' => 'park'], 'geometry' => $this->points([[92.899, 55.999], [92.901, 55.999], [92.901, 56.001], [92.899, 56.001], [92.899, 55.999]])];
        file_put_contents($this->directory.'/areas.json', json_encode(['elements' => [$polygon]]));
        $this->imports['green_areas'] = app(OsmAreaImporter::class)->import(OsmAreaDataset::GreenAreas, $this->directory.'/areas.json', $this->directory.'/boundary.json')['import_id'];
        $polygon['id'] = 102;
        $polygon['tags'] = ['natural' => 'water'];
        file_put_contents($this->directory.'/areas.json', json_encode(['elements' => [$polygon]]));
        $this->imports['water'] = app(OsmAreaImporter::class)->import(OsmAreaDataset::Water, $this->directory.'/areas.json', $this->directory.'/boundary.json')['import_id'];
        $lines = [['type' => 'way', 'id' => 201, 'tags' => ['highway' => 'primary'], 'geometry' => $this->points([[92.9, 55.99], [92.9, 56.01]])],
            ['type' => 'way', 'id' => 202, 'tags' => ['railway' => 'rail'], 'geometry' => $this->points([[92.905, 55.99], [92.905, 56.01]])]];
        file_put_contents($this->directory.'/lines.json', json_encode(['elements' => $lines]));
        foreach (OsmLinearDataset::cases() as $dataset) {
            $this->imports[$dataset->value] = app(OsmLinearImporter::class)->import($dataset, $this->directory.'/lines.json', $this->directory.'/boundary.json')['import_id'];
        }
        file_put_contents($this->directory.'/stops.csv', "id,name,type_transport,num_route,address,the_geom_lon,the_geom_lat\n1,Остановка,Автобус,12,,92.901,56.001\n");
        $this->imports['stops'] = app(OfficialStopsImporter::class)->import($this->directory.'/stops.csv', $this->directory.'/boundary.json')['import_id'];
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

    public function test_guest_profile_uses_exact_object_and_radius_with_source_quality_and_map(): void
    {
        $response = $this->getJson('/api/v1/addresses/osm:node:1/profile?radius_m=300&lon=37&lat=55')->assertOk()
            ->assertJsonPath('address.id', 'osm:node:1')->assertJsonPath('address.label', 'улица Тестовая, 10')
            ->assertJsonPath('point.lon', 92.9)->assertJsonPath('point.lat', 56)
            ->assertJsonPath('radius_m', 300)->assertJsonPath('map.analysis_area.type', 'Polygon')
            ->assertJsonPath('blocks.transport.data.metrics.stops_count.value', 1)
            ->assertJsonPath('blocks.parks.data.metrics.nearest_distance.value', 0)
            ->assertJsonPath('blocks.roads.data.metrics.nearest_distance.value', 0)
            ->assertJsonPath('blocks.railways.data.metrics.length.value', 0);
        foreach ($response->json('blocks') as $block) {
            $this->assertSame('READY', $block['status']);
            foreach ($block['data']['metrics'] as $metric) {
                $this->assertNotNull($metric['dataset_import_id']);
                $this->assertNull($metric['observed_at']);
                $this->assertSame('UNKNOWN', $metric['quality']['freshness']);
                $this->assertNotEmpty($metric['quality']['reason']);
            }
        }
        $this->assertEqualsWithDelta(600, $response->json('blocks.roads.data.metrics.length.value'), 1);
        $this->assertGreaterThan(300, $response->json('blocks.railways.data.metrics.nearest_distance.value'));
        $this->getJson('/api/v1/addresses/osm:node:2/profile')->assertOk()->assertJsonPath('point.lon', 92.901);
        $this->get('/address/osm:node:1?radius_m=300')->assertOk()->assertViewIs('welcome');
    }

    public function test_missing_source_is_null_while_other_categories_remain_available(): void
    {
        DB::table('dataset_imports')->where('dataset_key', 'water')->update(['is_active' => false]);
        $this->getJson('/api/v1/addresses/osm:node:1/profile')->assertOk()
            ->assertJsonPath('blocks.water.data.metrics.share.value', null)
            ->assertJsonPath('blocks.water.data.metrics.share.quality.availability', 'UNAVAILABLE')
            ->assertJsonPath('blocks.water.data.metrics.share.quality.method', null)
            ->assertJsonPath('blocks.transport.data.metrics.stops_count.value', 1)
            ->assertJsonPath('blocks.parks.status', 'READY')->assertJsonPath('blocks.roads.status', 'READY');
    }

    public function test_invalid_unknown_and_disappeared_ids_are_not_replaced_by_a_same_label_object(): void
    {
        foreach (['osm:node:9999999', 'osm:node:0', 'osm:other:1', 'address:group', 'osm:node:9223372036854775808'] as $id) {
            $this->getJson('/api/v1/addresses/'.rawurlencode($id).'/profile')->assertNotFound();
        }
        $this->addresses([2]);
        $this->getJson('/api/v1/addresses/osm:node:1/profile')->assertNotFound();
        $this->getJson('/api/v1/addresses/osm:node:2/profile')->assertOk()->assertJsonPath('address.id', 'osm:node:2');
        $this->assertSame(2, DB::table('osm_addresses')->where('dataset_import_id', $this->imports['addresses'])->count());
    }

    public function test_address_source_unavailable_and_invalid_radius_have_distinct_http_states(): void
    {
        foreach (['1000', '0', 'abc', '300.5'] as $radius) {
            $this->getJson('/api/v1/addresses/osm:node:1/profile?radius_m='.$radius)->assertUnprocessable();
        }
        DB::table('dataset_imports')->where('dataset_key', 'addresses')->update(['is_active' => false]);
        $this->getJson('/api/v1/addresses/osm:node:1/profile')->assertStatus(503)->assertJsonPath('message', 'Набор адресов недоступен. Попробуйте позже.');
    }

    public function test_failed_sql_category_is_isolated_and_diagnostics_are_not_exposed(): void
    {
        $real = app(OsmAreaAnalysisService::class);
        $mock = Mockery::mock(OsmAreaAnalysisService::class);
        $mock->shouldReceive('forKind')->andReturnUsing(function ($kind, ...$args) use ($real) {
            if ($kind === OsmAreaKind::Parks) {
                DB::select('SELECT 1/0');
            }

            return $real->forKind($kind, ...$args);
        });
        $this->app->instance(OsmAreaAnalysisService::class, $mock);
        $response = $this->getJson('/api/v1/addresses/osm:node:1/profile')->assertOk()
            ->assertJsonPath('blocks.parks.status', 'ERROR')->assertJsonPath('blocks.parks.data', null)
            ->assertJsonPath('blocks.vegetation.status', 'READY')->assertJsonPath('blocks.water.status', 'READY')
            ->assertJsonPath('blocks.transport.data.metrics.stops_count.value', 1)->assertJsonPath('map.analysis_area.type', 'Polygon');
        $this->assertStringNotContainsString('division by zero', $response->getContent());
        $this->assertStringNotContainsString('SQLSTATE', $response->getContent());
    }

    public function test_snapshot_ids_are_frozen_before_any_profile_block_is_calculated(): void
    {
        $real = app(TransportAnalysisService::class);
        $mock = Mockery::mock(TransportAnalysisService::class);
        $mock->shouldReceive('analyze')->once()->andReturnUsing(function (...$args) use ($real) {
            file_put_contents($this->directory.'/new-green.json', json_encode(['elements' => [
                ['type' => 'way', 'id' => 999, 'tags' => ['natural' => 'wood'], 'geometry' => $this->points([[92.898, 55.998], [92.902, 55.998], [92.902, 56.002], [92.898, 56.002], [92.898, 55.998]])],
            ]]));
            app(OsmAreaImporter::class)->import(OsmAreaDataset::GreenAreas, $this->directory.'/new-green.json', $this->directory.'/boundary.json', ['allow_large_drop' => true]);

            return $real->analyze(...$args);
        });
        $this->app->instance(TransportAnalysisService::class, $mock);
        $this->getJson('/api/v1/addresses/osm:node:1/profile')->assertOk()
            ->assertJsonPath('blocks.parks.data.metrics.share.dataset_import_id', $this->imports['green_areas'])
            ->assertJsonPath('blocks.vegetation.data.metrics.share.dataset_import_id', $this->imports['green_areas']);
        $this->assertFalse(DB::table('dataset_imports')->find($this->imports['green_areas'])->is_active);
    }

    public function test_linear_lengths_union_duplicate_segments_and_keep_parallel_carriageways(): void
    {
        $lines = [];
        foreach ([1 => 92.9, 2 => 92.9, 3 => 92.9001] as $id => $lon) {
            $lines[] = ['type' => 'way', 'id' => $id, 'tags' => ['highway' => 'primary'], 'geometry' => $this->points([[$lon, 55.99], [$lon, 56.01]])];
        }
        file_put_contents($this->directory.'/duplicate-lines.json', json_encode(['elements' => $lines]));
        $new = app(OsmLinearImporter::class)->import(OsmLinearDataset::Roads, $this->directory.'/duplicate-lines.json', $this->directory.'/boundary.json');
        $response = $this->getJson('/api/v1/addresses/osm:node:1/profile')->assertOk()
            ->assertJsonPath('blocks.roads.data.metrics.nearest_distance.value', 0)
            ->assertJsonPath('blocks.roads.data.metrics.length.dataset_import_id', $new['import_id']);
        $this->assertEqualsWithDelta(2000, $response->json('blocks.roads.data.metrics.length.value'), 2);
        $this->assertSame(3, DB::table('osm_roads')->where('dataset_import_id', $new['import_id'])->count());
    }

    public function test_missing_linear_coverage_does_not_turn_into_zero_length(): void
    {
        DB::table('dataset_coverages')->where('dataset_import_id', $this->imports['roads'])->delete();
        $this->getJson('/api/v1/addresses/osm:node:1/profile')->assertOk()
            ->assertJsonPath('blocks.roads.data.metrics.length.value', null)
            ->assertJsonPath('blocks.roads.data.metrics.length.quality.availability', 'UNAVAILABLE')
            ->assertJsonPath('blocks.railways.data.metrics.length.quality.availability', 'AVAILABLE')
            ->assertJsonPath('blocks.transport.data.metrics.stops_count.value', 1);
    }

    public function test_address_outside_service_area_retains_its_identity_with_no_invented_metrics(): void
    {
        DB::table('dataset_coverages')->update(['service_geom' => DB::raw('ST_MakeEnvelope(92,55,92.5,57,4326)')]);
        $response = $this->getJson('/api/v1/addresses/osm:node:1/profile')->assertOk()
            ->assertJsonPath('address.id', 'osm:node:1')->assertJsonPath('map.analysis_area.type', 'Polygon');
        foreach ($response->json('blocks') as $block) {
            $this->assertSame('READY', $block['status']);
            $this->assertSame('OUTSIDE_SERVICE_AREA', $block['data']['coverage']['status']);
            foreach ($block['data']['metrics'] as $metric) {
                $this->assertNull($metric['value']);
                $this->assertSame('UNAVAILABLE', $metric['quality']['availability']);
                $this->assertNull($metric['quality']['method']);
            }
        }
    }

    private function addresses(array $ids): array
    {
        file_put_contents($this->directory.'/addresses.json', json_encode(['elements' => array_map(fn ($id) => [
            'type' => 'node', 'id' => $id, 'lon' => round(92.9 + ($id - 1) * 0.001, 6), 'lat' => 56,
            'tags' => ['addr:street' => 'улица Тестовая', 'addr:housenumber' => '10'],
        ], $ids)]));

        return app(OsmAddressImporter::class)->import($this->directory.'/addresses.json', $this->directory.'/boundary.json', ['allow_large_drop' => true]);
    }

    private function points(array $points): array
    {
        return array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], $points);
    }
}
