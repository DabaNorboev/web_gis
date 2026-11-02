<?php

namespace Tests\Feature;

use App\Services\Addresses\AddressProfileService;
use App\Services\Addresses\AddressResolverService;
use App\Services\Gis\AnalysisArea;
use App\Services\Osm\Analysis\OsmAreaAnalysisService;
use App\Services\Osm\Analysis\OsmAreaMapService;
use App\Services\Osm\Analysis\OsmLinearAnalysisService;
use App\Services\Osm\Analysis\OsmLinearMapService;
use App\Services\Transport\TransportAnalysisService;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Schema;
use Mockery;
use RuntimeException;
use Tests\TestCase;

class SearchProfileApiTest extends TestCase
{
    private array $calls = [];

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'sqlite' || DB::connection()->getDatabaseName() !== ':memory:') {
            throw new RuntimeException('Search API fixtures require SQLite in memory.');
        }
    }

    private function address(): array
    {
        return ['id' => 'osm:node:1', 'label' => 'Synthetic address', 'object' => ['id' => 'osm:node:1', 'lon' => .12, 'lat' => .23,
            'geometry' => ['type' => 'Point', 'coordinates' => [.12, .23]], 'point_method' => 'osm_node', 'object_type' => 'address_point', 'levels' => null],
            'bounds' => [.12, .23, .12, .23], 'source' => 'OpenStreetMap', 'dataset_import_id' => 1, 'observed_at' => null, 'source_updated_at' => null, 'reason' => 'Synthetic'];
    }

    private function services(?string $fail = null): void
    {
        Http::preventStrayRequests();
        $resolver = Mockery::mock(AddressResolverService::class)->makePartial();
        $resolver->shouldReceive('snapshots')->andReturn([]);
        $resolver->shouldReceive('resolve')->andReturn($this->address());
        $this->app->instance(AddressResolverService::class, $resolver);
        $area = Mockery::mock(AnalysisArea::class);
        $area->shouldReceive('forPoint')->andReturn(['analysis_area' => ['type' => 'Polygon', 'coordinates' => [[[0, 0], [1, 0], [1, 1], [0, 0]]]], 'analysis_bounds' => [0, 0, 1, 1]]);
        $this->app->instance(AnalysisArea::class, $area);
        foreach ([TransportAnalysisService::class => 'analyze', OsmAreaAnalysisService::class => 'forKind', OsmLinearAnalysisService::class => 'forDataset',
            OsmAreaMapService::class => 'forKind', OsmLinearMapService::class => 'forDataset'] as $class => $method) {
            $mock = Mockery::mock($class);
            $mock->shouldReceive($method)->andReturnUsing(function (...$args) use ($class, $fail) {
                $key = $class === TransportAnalysisService::class ? 'transport' : $args[0]->value;
                $layer = in_array($class, [OsmAreaMapService::class, OsmLinearMapService::class], true);
                $this->calls[] = ($layer ? 'layer:' : '').$key;
                if (($layer ? 'layer:' : '').$key === $fail) {
                    throw new RuntimeException('Synthetic private SQL body must not appear in response');
                }

                return $layer ? ['type' => 'FeatureCollection', 'features' => [], 'radius_m' => 300]
                    : ['metrics' => [], 'stops_in_radius' => []];
            });
            $this->app->instance($class, $mock);
        }
    }

    public function test_selected_block_calls_only_that_analysis_and_its_map_layer(): void
    {
        $this->services();
        $response = $this->getJson('/api/v1/addresses/osm:node:1/profile?scope=selected&profile_version=1&blocks[]=parks&radius_m=300')
            ->assertOk()->assertHeader('Cache-Control', 'no-store, private')->assertHeader('Referrer-Policy', 'no-referrer')
            ->assertJsonPath('scope', 'selected')->assertJsonPath('profile_version', 1)->assertJsonPath('selected_blocks', ['parks']);
        $this->assertSame(['parks', 'layer:parks'], $this->calls);
        $this->assertSame(['parks'], array_keys($response->json('blocks')));
        $this->assertArrayNotHasKey('stops_in_radius', $response->json('map'));
        $this->assertArrayNotHasKey('linear_layers', $response->json('map'));
    }

    public function test_transport_selection_does_not_call_area_or_linear_analysis(): void
    {
        $this->services();
        $this->getJson('/api/v1/addresses/osm:node:1/profile?scope=selected&profile_version=1&blocks[]=transport')->assertOk()
            ->assertJsonPath('map.stops_in_radius', []);
        $this->assertSame(['transport'], $this->calls);
    }

    public function test_default_profile_keeps_all_blocks_and_layers_without_selected_metadata(): void
    {
        $this->services();
        $response = $this->getJson('/api/v1/addresses/osm:node:1/profile')->assertOk();
        $this->assertSame(AddressProfileService::BLOCKS, array_keys($response->json('blocks')));
        $this->assertArrayNotHasKey('scope', $response->json());
        $this->assertCount(11, $this->calls);
    }

    public function test_failed_block_is_isolated_and_does_not_hide_other_selected_results(): void
    {
        $this->services('water');
        $response = $this->getJson('/api/v1/addresses/osm:node:1/profile?scope=selected&profile_version=1&blocks[]=parks&blocks[]=water')->assertOk()
            ->assertJsonPath('blocks.parks.status', 'READY')->assertJsonPath('blocks.water.status', 'ERROR')
            ->assertJsonPath('blocks.water.code', 'BLOCK_CALCULATION_FAILED')->assertJsonPath('map.area_layers.water.code', 'BLOCK_CALCULATION_FAILED');
        $this->assertSame(['parks', 'water', 'layer:parks'], $this->calls);
        $this->assertStringNotContainsString('Synthetic private SQL', $response->getContent());
    }

    public function test_layer_failure_keeps_calculated_metrics_and_uses_its_own_code(): void
    {
        $this->services('layer:parks');
        $this->getJson('/api/v1/addresses/osm:node:1/profile?scope=selected&profile_version=1&blocks[]=parks')->assertOk()
            ->assertJsonPath('blocks.parks.status', 'READY')->assertJsonPath('map.area_layers.parks.status', 'ERROR')
            ->assertJsonPath('map.area_layers.parks.code', 'LAYER_CALCULATION_FAILED');
    }

    public function test_top_level_selected_failure_is_sanitized_and_retryable(): void
    {
        $this->services();
        $area = Mockery::mock(AnalysisArea::class);
        $area->shouldReceive('forPoint')->andThrow(new RuntimeException('Synthetic private geometry SQL'));
        $this->app->instance(AnalysisArea::class, $area);
        $response = $this->getJson('/api/v1/addresses/osm:node:1/profile?scope=selected&profile_version=1&blocks[]=parks')
            ->assertStatus(503)->assertHeader('Cache-Control', 'no-store, private')->assertJsonPath('code', 'SERVICE_UNAVAILABLE');
        $this->assertStringNotContainsString('Synthetic private', $response->getContent());
    }

    public function test_selection_requires_version_and_an_explicit_unique_whitelist(): void
    {
        foreach (['scope=selected', 'scope=selected&profile_version=1&blocks[]=unknown',
            'scope=selected&profile_version=2&blocks[]=parks', 'blocks[]=parks',
            'scope=selected&profile_version=1&blocks[]=parks&blocks[]=parks', 'scope=full&blocks[]=parks',
            'scope=selected&profile_version=1&blocks[]=parks&radius_m=1000',
            'scope=selected&profile_version=1&blocks[name]=parks'] as $query) {
            $this->getJson('/api/v1/addresses/osm:node:1/profile?'.$query)->assertUnprocessable();
        }
    }

    public function test_resolver_endpoint_exposes_address_and_capability_without_profile_calculation(): void
    {
        $this->services();
        $this->getJson('/api/v1/addresses/osm:node:1')->assertOk()->assertHeader('Cache-Control', 'no-store, private')
            ->assertJsonPath('address.id', 'osm:node:1')->assertJsonPath('capabilities.selected_profile_version', 1)
            ->assertJsonMissingPath('blocks')->assertJsonMissingPath('calculated_at');
        $this->assertSame([], $this->calls);
    }

    public function test_resolver_source_failure_does_not_expose_exception_or_become_not_found(): void
    {
        $resolver = Mockery::mock(AddressResolverService::class)->makePartial();
        $resolver->shouldReceive('resolve')->andThrow(new RuntimeException('Synthetic SQL / personal body'));
        $this->app->instance(AddressResolverService::class, $resolver);
        $response = $this->getJson('/api/v1/addresses/osm:node:1')->assertStatus(503)->assertJsonPath('code', 'ADDRESS_SOURCE_UNAVAILABLE');
        $this->assertStringNotContainsString('Synthetic SQL', $response->getContent());
    }

    public function test_exact_lookup_uses_active_snapshot_id_and_never_analytical_services(): void
    {
        $row = (object) ['label' => 'Synthetic', 'point_method' => 'osm_node', 'lon' => .12, 'lat' => .23,
            'geometry' => '{"type":"Point","coordinates":[0.12,0.23]}', 'west' => .12, 'south' => .23, 'east' => .12, 'north' => .23, 'levels' => null, 'object_type' => 'address_point'];
        $query = Mockery::mock(Builder::class);
        DB::shouldReceive('table')->once()->with('osm_addresses')->andReturn($query);
        $query->shouldReceive('where')->once()->with('dataset_import_id', 42)->andReturnSelf();
        $query->shouldReceive('where')->once()->with('osm_type', 'node')->andReturnSelf();
        $query->shouldReceive('where')->once()->with('osm_id', '1')->andReturnSelf();
        $query->shouldReceive('selectRaw')->once()->andReturnSelf();
        $query->shouldReceive('first')->once()->andReturn($row);
        $value = (new AddressResolverService)->resolve('osm:node:1', ['addresses' => (object) ['id' => 42, 'observed_at' => null, 'source_updated_at' => null]]);
        $this->assertSame(42, $value['dataset_import_id']);
        $this->assertNull($value['observed_at']);
        $this->assertArrayNotHasKey('calculated_at', $value);
    }

    public function test_missing_object_is_not_substituted_with_saved_coordinates_or_a_label_match(): void
    {
        $query = Mockery::mock(Builder::class);
        DB::shouldReceive('table')->once()->with('osm_addresses')->andReturn($query);
        $query->shouldReceive('where')->times(3)->andReturnSelf();
        $query->shouldReceive('selectRaw')->once()->andReturnSelf();
        $query->shouldReceive('first')->once()->andReturnNull();
        try {
            (new AddressResolverService)->resolve('osm:node:1', ['addresses' => (object) ['id' => 42]]);
            $this->fail('Missing object must not resolve');
        } catch (HttpResponseException $error) {
            $this->assertSame(404, $error->getResponse()->getStatusCode());
            $this->assertSame('ADDRESS_NOT_FOUND', $error->getResponse()->getData(true)['code']);
        }
    }

    public function test_missing_dataset_and_invalid_id_are_distinct_without_spatial_queries(): void
    {
        DB::shouldReceive('table')->never();
        foreach ([['osm:node:1', [], 503, 'ADDRESS_SOURCE_UNAVAILABLE'], ['address:group', [], 404, 'ADDRESS_NOT_FOUND'],
            ['osm:way:9999999999999999999', [], 404, 'ADDRESS_NOT_FOUND']] as [$id, $snapshots, $status, $code]) {
            try {
                (new AddressResolverService)->resolve($id, $snapshots);
                $this->fail('Lookup must fail');
            } catch (HttpResponseException $error) {
                $this->assertSame($status, $error->getResponse()->getStatusCode());
                $this->assertSame($code, $error->getResponse()->getData(true)['code']);
            }
        }
    }

    public function test_snapshots_selects_only_active_successful_addresses_for_resolver(): void
    {
        Schema::create('dataset_imports', function ($t) {
            $t->id();
            $t->string('source');
            $t->string('dataset_key');
            $t->string('status');
            $t->boolean('is_active');
        });
        foreach ([['addresses', 'succeeded', true], ['addresses', 'failed', true], ['addresses', 'succeeded', false], ['roads', 'succeeded', true]] as [$dataset, $status, $active]) {
            DB::table('dataset_imports')->insert(['source' => 'OpenStreetMap', 'dataset_key' => $dataset, 'status' => $status, 'is_active' => $active]);
        }
        $snapshots = (new AddressResolverService)->snapshots(true);
        $this->assertSame(['addresses'], array_keys($snapshots));
        $this->assertSame(1, $snapshots['addresses']->id);
    }
}
