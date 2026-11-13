<?php

namespace Tests\Feature;

use App\Http\Requests\PlaceAnalysisRequest;
use App\Services\Addresses\AddressProfileService;
use App\Services\Addresses\AddressResolverService;
use App\Services\Analysis\PlaceAnalysisService;
use App\Services\Analysis\RetailPoiProvider;
use App\Services\Gis\AnalysisArea;
use Illuminate\Routing\RouteCollection;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Mockery;
use RuntimeException;
use Tests\TestCase;

class PlaceAnalysisApiTest extends TestCase
{
    private const PATH = '/api/v1/place-analysis';

    private const POINT = ['place' => ['kind' => 'point', 'lon' => 0.12, 'lat' => 0.23]];

    private const MAP = ['analysis_area' => ['type' => 'Polygon', 'coordinates' => [[[0, 0], [1, 0], [1, 1], [0, 0]]]],
        'analysis_bounds' => [0, 0, 1, 1]];

    private function area(float $lon = .12, float $lat = .23, int $radius = 500): void
    {
        Http::preventStrayRequests();
        $this->mock(AnalysisArea::class, fn ($m) => $m->shouldReceive('forPoint')->once()->with($lon, $lat, $radius)->andReturn(self::MAP));
    }

    public function test_defaults_and_unavailable_providers_preserve_full_circle_and_nulls(): void
    {
        $this->area();
        $this->mock(AddressResolverService::class, fn ($m) => $m->shouldNotReceive('snapshots', 'resolve'));
        $r = $this->postJson(self::PATH, self::POINT)->assertOk()
            ->assertHeader('Cache-Control', 'no-store, private')->assertHeader('Referrer-Policy', 'no-referrer')
            ->assertJsonPath('analysis_version', 1)->assertJsonPath('radius_m', 500)->assertJsonPath('date', null)
            ->assertJsonPath('station_selection', ['selected_ids' => [], 'radius_m' => 5000])
            ->assertJsonPath('place', ['kind' => 'point', 'label' => null, 'address' => null, 'point' => ['lon' => .12, 'lat' => .23]])
            ->assertJsonPath('analysis_area', self::MAP['analysis_area'])->assertJsonPath('analysis_bounds', self::MAP['analysis_bounds']);
        $this->assertSame(['poi', 'satellite', 'air'], array_keys($r->json('blocks')));
        foreach (PlaceAnalysisService::BLOCKS as $key) {
            $r->assertJsonPath("blocks.$key.status", 'UNAVAILABLE')->assertJsonPath("blocks.$key.code", match ($key) {
                'poi' => 'POI_SNAPSHOTS_UNAVAILABLE', 'satellite' => 'SATELLITE_NOT_CONFIGURED', default => 'BLOCK_NOT_AVAILABLE'
            })
                ->assertJsonPath("blocks.$key.data", null);
            $this->assertMatchesRegularExpression('/Z$/', $r->json("blocks.$key.calculated_at"));
        }
        $r->assertJsonPath('blocks.poi.coverage.status', 'UNKNOWN')->assertJsonPath('blocks.poi.coverage.available_radius_m', null)
            ->assertJsonPath('blocks.poi.coverage.by_category.official_stop.status', 'UNKNOWN')
            ->assertJsonPath('blocks.satellite.coverage', null)->assertJsonPath('blocks.satellite.completeness', null)
            ->assertJsonPath('blocks.air.coverage', null)->assertJsonPath('blocks.air.completeness.status', 'UNKNOWN');
    }

    public function test_explicit_echo_and_each_single_block_selection(): void
    {
        $this->mock(AnalysisArea::class, fn ($m) => $m->shouldReceive('forPoint')->times(3)->with(.12, .23, 777)->andReturn(self::MAP));
        foreach (PlaceAnalysisService::BLOCKS as $key) {
            $r = $this->postJson(self::PATH, self::POINT + ['radius_m' => 777, 'date' => '2024-02-29',
                'stations' => ['selected_ids' => ['synthetic-unknown'], 'radius_m' => 20000], 'blocks' => [$key]])->assertOk()
                ->assertJsonPath('radius_m', 777)->assertJsonPath('date', '2024-02-29')
                ->assertJsonPath('station_selection', ['selected_ids' => ['synthetic-unknown'], 'radius_m' => 20000]);
            $this->assertSame([$key], array_keys($r->json('blocks')));
        }
    }

    public function test_address_uses_resolver_identity_and_point_not_object_bounds(): void
    {
        $address = ['id' => 'osm:way:1', 'label' => 'Synthetic', 'object' => ['id' => 'osm:way:1', 'lon' => .4, 'lat' => .5], 'bounds' => [.4, .5, .4, .5]];
        $resolver = Mockery::mock(AddressResolverService::class)->makePartial();
        $resolver->shouldReceive('snapshots')->once()->with(true)->andReturn(['addresses' => (object) ['id' => 123]]);
        $resolver->shouldReceive('resolve')->once()->with('osm:way:1', Mockery::on(fn ($s) => $s['addresses']->id === 123))->andReturn($address);
        $this->app->instance(AddressResolverService::class, $resolver);
        $this->area(.4, .5, 200);
        $this->postJson(self::PATH, ['place' => ['kind' => 'address', 'address_id' => 'osm:way:1'], 'radius_m' => 200])
            ->assertOk()->assertJsonPath('place.address', $address)->assertJsonPath('place.label', 'Synthetic')
            ->assertJsonPath('place.point', ['lon' => .4, 'lat' => .5])->assertJsonPath('analysis_bounds', self::MAP['analysis_bounds']);
    }

    public function test_invalid_input_never_runs_analysis_or_echoes_values(): void
    {
        config(['app.debug' => true]);
        $this->mock(PlaceAnalysisService::class, fn ($m) => $m->shouldNotReceive('analyze'));
        $cases = [[], ['place' => null], ['place' => 'private-canary'],
            ['place' => ['kind' => 'address']], ['place' => ['kind' => 'point', 'lon' => 0]],
            ['place' => ['kind' => 'point', 'lon' => 0, 'lat' => 0, 'address_id' => 'osm:node:1']],
            ['place' => ['kind' => 'address', 'address_id' => 'osm:node:1', 'lon' => 0]],
        ];
        foreach ([199, 1001, 200.5, '500', null, true] as $value) {
            $cases[] = array_replace(self::POINT, ['radius_m' => $value]);
        }
        foreach (['2026-02-29', '2026-1-01', null, 'private-canary'] as $value) {
            $cases[] = self::POINT + ['date' => $value];
        }
        foreach ([[], ['poi', 'poi'], ['private-canary'], null, ['a' => 'poi']] as $value) {
            $cases[] = self::POINT + ['blocks' => $value];
        }
        foreach ([['radius_m' => 999], ['radius_m' => 20001], ['radius_m' => '5000'], ['selected_ids' => ['x', 'x']],
            ['selected_ids' => array_fill(0, 21, 'x')], ['selected_ids' => [str_repeat('x', 65)]], ['selected_ids' => [null]], null] as $value) {
            $cases[] = self::POINT + ['stations' => $value];
        }
        foreach (['0', null, true, 181, ['private-canary']] as $lon) {
            $cases[] = ['place' => ['kind' => 'point', 'lon' => $lon, 'lat' => 0]];
        }
        $cases[] = ['place' => ['kind' => 'point', 'lon' => 0, 'lat' => -91]];
        foreach ($cases as $input) {
            $this->postJson(self::PATH, $input)->assertStatus(422)->assertHeader('Cache-Control', 'no-store, private')->assertDontSee('private-canary');
        }
        $this->postJson(self::PATH.'?place[kind]=point&place[lon]=0&place[lat]=0', [])->assertStatus(422);
    }

    public function test_body_limit_json_errors_and_methods_are_private(): void
    {
        $this->mock(PlaceAnalysisService::class, fn ($m) => $m->shouldNotReceive('analyze'));
        foreach ([['CONTENT_TYPE' => 'application/json', 'CONTENT_LENGTH' => '1'], ['CONTENT_TYPE' => 'application/json']] as $headers) {
            $this->call('POST', self::PATH, [], [], [], $headers, str_repeat('x', 8193))->assertStatus(413)
                ->assertHeader('Cache-Control', 'no-store, private')->assertDontSee(str_repeat('x', 20));
        }
        $this->post(self::PATH, self::POINT)->assertStatus(415)->assertHeader('Referrer-Policy', 'no-referrer');
        foreach (['{private-canary', '[]', 'null'] as $body) {
            $this->call('POST', self::PATH, [], [], [], ['CONTENT_TYPE' => 'application/json'], $body)->assertStatus(422)->assertDontSee('private-canary');
        }
        foreach ([
            '{"place":{"kind":"point","lon":0,"lat":0},"radius_m":500.0}',
            '{"place":{"kind":"point","lon":0,"lat":0},"blocks":{"0":"poi"}}',
            '{"place":{"kind":"point","lon":0,"lat":0},"stations":{"selected_ids":{}}}',
            '{"place":{"kind":"point","lon":1e999,"lat":0}}',
        ] as $body) {
            $this->call('POST', self::PATH, [], [], [], ['CONTENT_TYPE' => 'application/json'], $body)->assertStatus(422);
        }
        $this->getJson(self::PATH)->assertStatus(405)->assertHeader('Cache-Control', 'no-store, private');
    }

    public function test_exact_body_limit_and_station_list_limit_are_accepted(): void
    {
        $this->area();
        $ids = array_map(fn ($i) => 'synthetic-'.$i, range(1, 20));
        $body = json_encode(self::POINT + ['stations' => ['selected_ids' => $ids, 'radius_m' => 1000]]);
        $body = str_pad($body, 8192, ' ');
        $this->call('POST', self::PATH, [], [], [], ['CONTENT_TYPE' => 'application/json'], $body)->assertOk()
            ->assertJsonPath('station_selection', ['selected_ids' => $ids, 'radius_m' => 1000]);
    }

    public function test_orchestration_and_pre_controller_failures_hide_debug_payload_and_logs(): void
    {
        config(['app.debug' => true]);
        $this->mock(PlaceAnalysisService::class, fn ($m) => $m->shouldReceive('analyze')->once()->andThrow(new RuntimeException('private-canary SQL bindings')));
        Log::shouldReceive('error')->twice()->with('Place analysis request failed.', ['exception_type' => RuntimeException::class]);
        $this->postJson(self::PATH, self::POINT)->assertStatus(503)->assertJsonPath('code', 'SERVICE_UNAVAILABLE')
            ->assertDontSee('private-canary')->assertHeader('Cache-Control', 'no-store, private');
        $this->app->beforeResolving(PlaceAnalysisRequest::class,
            fn () => throw new RuntimeException('private-canary before controller'));
        $this->postJson(self::PATH, self::POINT)->assertStatus(503)->assertDontSee('private-canary');
    }

    public function test_missing_route_still_has_safe_headers(): void
    {
        $this->app['router']->setRoutes(new RouteCollection);
        $this->postJson(self::PATH, self::POINT)->assertNotFound()->assertJsonPath('code', 'NOT_FOUND')
            ->assertHeader('Cache-Control', 'no-store, private')->assertHeader('Referrer-Policy', 'no-referrer');
    }

    public function test_legacy_profile_accepts_300_and_500_and_rejects_1000(): void
    {
        $this->mock(AddressProfileService::class, function ($m) {
            foreach ([300, 500] as $radius) {
                $m->shouldReceive('profile')->once()->with('osm:node:1', $radius, null)->andReturn(['radius_m' => $radius]);
            }
        });
        foreach ([300, 500] as $radius) {
            $this->getJson('/api/v1/addresses/osm:node:1/profile?radius_m='.$radius)->assertOk()->assertJsonPath('radius_m', $radius);
        }
        $this->getJson('/api/v1/addresses/osm:node:1/profile?radius_m=1000')->assertUnprocessable();
    }

    public function test_resolver_domain_errors_and_unexpected_circle_error(): void
    {
        $this->postJson(self::PATH, ['place' => ['kind' => 'address', 'address_id' => 'address:private-canary']])
            ->assertNotFound()->assertJsonPath('code', 'ADDRESS_NOT_FOUND')->assertDontSee('private-canary');
        $resolver = Mockery::mock(AddressResolverService::class)->makePartial();
        $resolver->shouldReceive('snapshots')->andReturn([]);
        $this->app->instance(AddressResolverService::class, $resolver);
        $this->postJson(self::PATH, ['place' => ['kind' => 'address', 'address_id' => 'osm:node:1']])
            ->assertStatus(503)->assertJsonPath('code', 'ADDRESS_SOURCE_UNAVAILABLE');
        $this->mock(AnalysisArea::class, fn ($m) => $m->shouldReceive('forPoint')->once()->andThrow(new RuntimeException('private-canary')));
        Log::shouldReceive('error')->once()->with('Place analysis request failed.', ['exception_type' => RuntimeException::class]);
        $this->postJson(self::PATH, self::POINT)->assertStatus(503)->assertJsonPath('code', 'SERVICE_UNAVAILABLE')->assertDontSee('private-canary');
    }

    public function test_block_failure_is_independent_and_safe(): void
    {
        $this->area();
        $service = Mockery::mock(PlaceAnalysisService::class, [app(AddressResolverService::class), app(AnalysisArea::class), app(RetailPoiProvider::class)])
            ->makePartial()->shouldAllowMockingProtectedMethods();
        $service->shouldReceive('calculateBlock')->once()->with('poi', Mockery::type('array'), 500)->andThrow(new RuntimeException('private-canary'));
        $this->app->instance(PlaceAnalysisService::class, $service);
        Log::shouldReceive('error')->once()->with('Place analysis block failed.', ['exception_type' => RuntimeException::class, 'block' => 'poi']);
        $this->postJson(self::PATH, self::POINT)->assertOk()->assertJsonPath('blocks.poi.status', 'ERROR')
            ->assertJsonPath('blocks.poi.code', 'BLOCK_CALCULATION_FAILED')->assertJsonPath('blocks.poi.data', null)
            ->assertJsonPath('blocks.air.status', 'UNAVAILABLE')->assertJsonPath('blocks.satellite.status', 'UNAVAILABLE')->assertDontSee('private-canary');
    }

    public function test_satellite_error_does_not_claim_catalog_coverage_or_completeness(): void
    {
        $this->area();
        $service = Mockery::mock(PlaceAnalysisService::class, [app(AddressResolverService::class), app(AnalysisArea::class), app(RetailPoiProvider::class)])
            ->makePartial()->shouldAllowMockingProtectedMethods();
        $service->shouldReceive('calculateBlock')->once()->with('satellite', Mockery::type('array'), 500)->andThrow(new RuntimeException('private-canary'));
        $this->app->instance(PlaceAnalysisService::class, $service);
        Log::shouldReceive('error')->once()->with('Place analysis block failed.', ['exception_type' => RuntimeException::class, 'block' => 'satellite']);
        $this->postJson(self::PATH, self::POINT + ['blocks' => ['satellite']])->assertOk()
            ->assertJsonPath('blocks.satellite.status', 'ERROR')->assertJsonPath('blocks.satellite.coverage', null)
            ->assertJsonPath('blocks.satellite.completeness', null)->assertDontSee('private-canary');
    }

    public function test_throttle_is_shared_across_block_selection_and_has_retry_after(): void
    {
        $this->mock(PlaceAnalysisService::class, fn ($m) => $m->shouldReceive('analyze')->times(60)->andReturn([]));
        for ($i = 0; $i < 60; $i++) {
            $this->postJson(self::PATH, self::POINT + ['blocks' => [PlaceAnalysisService::BLOCKS[$i % 3]]])->assertOk();
        }
        $this->postJson(self::PATH, self::POINT)->assertStatus(429)->assertHeader('Retry-After')
            ->assertHeader('Cache-Control', 'no-store, private')->assertJsonPath('code', 'TOO_MANY_REQUESTS');
    }
}
