<?php

namespace Tests\Feature;

use App\Services\Routing\LocalCarRouterProvider;
use App\Services\Routing\LocalWalkingRouterProvider;
use App\Services\Routing\WalkingGeometryGuard;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Tests\TestCase;

class WalkingTripAnalysisTest extends TestCase
{
    private string $folder;

    protected function setUp(): void
    {
        parent::setUp();
        Http::preventStrayRequests();
        $this->folder = sys_get_temp_dir().'/walking-api-'.bin2hex(random_bytes(6));
        mkdir($this->folder);
        $manifest = ['version' => 'walking-test', 'engine' => 'ORS', 'engine_version' => '10.1.0',
            'mode' => 'walking', 'profile' => 'foot-walking', 'guard_cell_degrees' => .005,
            'guard_hashes' => [], 'way_hashes' => [], 'bbox' => [-1, -1, 1, 1],
            'pbf_sha256' => str_repeat('a', 64), 'extract_sha256' => str_repeat('b', 64),
            'observed_at' => null, 'prepared_at' => '2026-10-26T00:00:00Z', 'guard_sources' => ['imports' => []]];
        $raw = json_encode($manifest);
        file_put_contents($this->folder.'/manifest.json', $raw);
        config(['routing.walking.snapshot_path' => $this->folder, 'routing.walking.version' => 'walking-test',
            'routing.walking.manifest_sha256' => hash('sha256', $raw)]);
        $this->mock(WalkingGeometryGuard::class, function ($mock) {
            $mock->shouldReceive('scope')->andReturn(true);
            $mock->shouldReceive('validatePoint')->andReturnUsing(fn ($snapshot, $point) => ['status' => 'SELECTED', 'point' => $point, 'checks' => []]);
            $mock->shouldReceive('review')->andReturnUsing(fn ($snapshot, $body) => ['status' => 'AVAILABLE',
                'reason' => 'Synthetic source chain', 'checks' => [],
                'geometry' => ['type' => 'LineString', 'coordinates' => [[0, 0], [.0005, .000007], [.001, 0]]],
                'distance_m' => 112.0, 'duration_s' => 80.0]);
        });
    }

    protected function tearDown(): void
    {
        unlink($this->folder.'/manifest.json');
        rmdir($this->folder);
        parent::tearDown();
    }

    private function data(): array
    {
        return ['mode' => 'walking', 'start' => ['lon' => 0, 'lat' => 0],
            'places' => [['lon' => .001, 'lat' => 0, 'label' => 'Synthetic public place']]];
    }

    private function body(float $distance = 111, float $duration = 80): array
    {
        return ['type' => 'FeatureCollection', 'features' => [['type' => 'Feature',
            'geometry' => ['type' => 'LineString', 'coordinates' => [[0, 0], [.001, 0]]],
            'properties' => ['summary' => compact('distance', 'duration'),
                'extras' => ['osmId' => ['values' => [[0, 1, 1]]]]]]]];
    }

    public function test_street_metrics_and_canonical_geometry_are_explicitly_separate_from_objects(): void
    {
        $this->mock(LocalCarRouterProvider::class, fn ($m) => $m->shouldNotReceive('analyze'));
        Http::fake(['local-walking:8082/*' => Http::response($this->body())]);
        $data = $this->data();
        $data['start'] = ['lon' => 2, 'lat' => .001, 'road' => ['lon' => 0, 'lat' => 0]];
        $data['places'][0] = ['lon' => .002, 'lat' => .001, 'road' => ['lon' => .001, 'lat' => 0], 'label' => 'Synthetic object'];
        $response = $this->postJson('/api/v1/trips/analyze', $data)->assertOk()
            ->assertHeader('Cache-Control', 'no-store, private')
            ->assertJsonPath('mode', 'walking')->assertJsonPath('route_scope', 'street_points')
            ->assertJsonPath('source.engine', 'ORS')->assertJsonPath('source.profile', 'foot-walking')
            ->assertJsonPath('results.0.status', 'AVAILABLE')->assertJsonPath('results.0.selection_kind', 'DIFFERENT_STREET_POINTS')
            ->assertJsonPath('results.0.approaches.start.status', 'UNKNOWN')
            ->assertJsonPath('results.0.approaches.start.distance_m', null)
            ->assertJsonPath('results.0.address_metrics.distance.value', null)
            ->assertJsonPath('results.0.address_metrics.duration.value', null)
            ->assertJsonPath('results.0.metrics.distance.scope', 'street_points')
            ->assertJsonPath('results.0.metrics.distance.value', 112)
            ->assertJsonPath('results.0.metrics.duration.value', 80)
            ->assertJsonPath('results.0.metrics.duration.quality.freshness', 'UNKNOWN')
            ->assertJsonPath('source.observed_at', null);
        $this->assertSame(['lon' => 2, 'lat' => .001], $response->json('results.0.start'));
        $this->assertCount(3, $response->json('results.0.route.geometry.coordinates'));
        $this->assertSame(['lon' => 0, 'lat' => 0], $response->json('results.0.street_points.start'));
        $request = Http::recorded()[0][0];
        $this->assertSame('POST', $request->method());
        $this->assertSame('http://local-walking:8082/ors/v2/directions/foot-walking/geojson', $request->url());
        $this->assertEquals([[0, 0], [.001, 0]], $request['coordinates']);
        $this->assertSame([20, 20], $request['radiuses']);
        $this->assertFalse($request['geometry_simplify']);
    }

    public function test_unconfirmed_original_point_is_never_automatically_replaced(): void
    {
        $this->mock(WalkingGeometryGuard::class, function ($m) {
            $m->shouldReceive('scope')->andReturn(true);
            $m->shouldReceive('validatePoint')->andReturnUsing(fn ($snapshot, $p) => $p['lon'] === 0.0
                ? ['status' => 'NEEDS_REFINEMENT', 'checks' => ['START_IN_BUILDING']]
                : ['status' => 'SELECTED', 'checks' => []]);
            $m->shouldNotReceive('review');
        });
        Http::fake();
        $this->postJson('/api/v1/trips/analyze', $this->data())->assertOk()
            ->assertJsonPath('results.0.status', 'NEEDS_REFINEMENT')->assertJsonPath('results.0.route', null)
            ->assertJsonPath('results.0.metrics.distance.value', null)
            ->assertJsonPath('results.0.diagnostics.issues.0.location', 'start');
        Http::assertNothingSent();
    }

    public function test_one_to_three_targets_keep_independent_failures_and_null_measures(): void
    {
        Http::fakeSequence()->push($this->body())->push(['error' => ['code' => 2009, 'message' => 'SYNTHETIC_PRIVATE_REMOTE_ERROR']], 404)
            ->pushResponse(Http::failedConnection());
        $data = $this->data();
        $data['places'] = array_fill(0, 3, $data['places'][0]);
        $response = $this->postJson('/api/v1/trips/analyze', $data)->assertOk()
            ->assertJsonPath('results.0.status', 'AVAILABLE')->assertJsonPath('results.1.status', 'NO_PATH')
            ->assertJsonPath('results.2.status', 'UNAVAILABLE')->assertDontSee('SYNTHETIC_PRIVATE_REMOTE_ERROR')
            ->assertJsonPath('results.2.metrics.distance.quality.availability', 'UNAVAILABLE');
        foreach ([1, 2] as $index) {
            $this->assertNull($response->json("results.$index.route"));
            $this->assertNull($response->json("results.$index.metrics.distance.value"));
            $this->assertNull($response->json("results.$index.metrics.duration.value"));
            $this->assertNull($response->json("results.$index.metrics.duration.quality.method"));
        }
    }

    public function test_missing_walking_snapshot_and_outside_points_do_not_contact_router(): void
    {
        Http::fake();
        $data = $this->data();
        $data['start']['lon'] = 2;
        $this->postJson('/api/v1/trips/analyze', $data)->assertOk()
            ->assertJsonPath('results.0.status', 'OUTSIDE_PILOT')->assertJsonPath('results.0.metrics.distance.value', null)
            ->assertJsonPath('results.0.metrics.distance.quality.availability', 'UNAVAILABLE');
        config(['routing.walking.manifest_sha256' => str_repeat('0', 64)]);
        $this->postJson('/api/v1/trips/analyze', $this->data())->assertOk()
            ->assertJsonPath('results.0.status', 'UNAVAILABLE')->assertJsonPath('source', null);
        Http::assertNothingSent();
    }

    public function test_walking_unavailability_does_not_prevent_car_dispatch(): void
    {
        config(['routing.walking.manifest_sha256' => str_repeat('0', 64)]);
        $this->mock(LocalCarRouterProvider::class, fn ($m) => $m->shouldReceive('analyze')->once()->andReturn(['mode' => 'driving', 'results' => []]));
        $data = $this->data();
        $this->postJson('/api/v1/trips/analyze', [...$data, 'mode' => 'driving'])->assertOk()->assertJsonPath('mode', 'driving');
    }

    public function test_invalid_and_zero_measures_oversize_and_redirect_cannot_publish_routes(): void
    {
        Http::fakeSequence()->push($this->body(2, 0))->push($this->body(0, 0))
            ->push(str_repeat('x', 2_000_001))->push('', 302, ['Location' => 'https://example.invalid/should-not-contact']);
        foreach (['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNAVAILABLE'] as $status) {
            $this->postJson('/api/v1/trips/analyze', $this->data())->assertOk()
                ->assertJsonPath('results.0.status', $status)->assertJsonPath('results.0.route', null)
                ->assertJsonPath('results.0.metrics.duration.value', null);
        }
    }

    public function test_unhandled_walking_exception_reports_only_type_without_debug_payload(): void
    {
        config(['app.debug' => true]);
        $this->mock(LocalWalkingRouterProvider::class, fn ($m) => $m->shouldReceive('analyze')
            ->andThrow(new RuntimeException('SYNTHETIC_WALKING_PRIVATE_PAYLOAD')));
        Log::shouldReceive('error')->once()->with('Trip request failed.', ['exception_type' => RuntimeException::class]);
        $this->postJson('/api/v1/trips/analyze', $this->data())->assertStatus(500)
            ->assertDontSee('SYNTHETIC_WALKING_PRIVATE_PAYLOAD')->assertJson(['message' => 'Расчёт поездок временно недоступен.']);
    }

    public function test_failed_geometry_check_is_unknown_and_never_a_false_coverage_claim(): void
    {
        $this->mock(WalkingGeometryGuard::class, fn ($m) => $m->shouldReceive('scope')->andThrow(new RuntimeException('SYNTHETIC_INTERNAL_GEOMETRY')));
        Http::fake();
        $this->postJson('/api/v1/trips/analyze', $this->data())->assertOk()
            ->assertJsonPath('results.0.status', 'UNKNOWN')->assertDontSee('SYNTHETIC_INTERNAL_GEOMETRY');
        Http::assertNothingSent();
    }
}
