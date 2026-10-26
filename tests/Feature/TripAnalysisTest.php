<?php

namespace Tests\Feature;

use App\Services\Routing\RoutingGeometryGuard;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class TripAnalysisTest extends TestCase
{
    private string $folder;

    protected function setUp(): void
    {
        parent::setUp();
        Http::preventStrayRequests();
        $this->folder = sys_get_temp_dir().'/trip-test-'.bin2hex(random_bytes(6));
        mkdir($this->folder);
        $manifest = ['version' => 'test', 'mode' => 'driving', 'engine_version' => '5.27.1', 'snap_limit_m' => 35,
            'pbf_sha256' => str_repeat('a', 64), 'extract_sha256' => str_repeat('b', 64), 'observed_at' => null,
            'prepared_at' => '2026-10-20T00:00:00Z', 'bbox' => [92.7, 55.9, 93.2, 56.2], 'guard_sources' => ['imports' => []]];
        $raw = json_encode($manifest);
        file_put_contents($this->folder.'/manifest.json', $raw);
        config(['routing.snapshot_path' => $this->folder, 'routing.version' => 'test', 'routing.manifest_sha256' => hash('sha256', $raw)]);
        $this->mock(RoutingGeometryGuard::class, function ($mock) {
            $mock->shouldReceive('scope')->andReturn(true);
            $mock->shouldReceive('resolve')->andReturnUsing(fn ($snapshot, $point) => ['status' => 'SELECTED', 'point' => $point, 'candidates' => []]);
            $mock->shouldReceive('review')->andReturn(['status' => 'AVAILABLE', 'reason' => 'Model verified', 'checks' => []]);
        });
    }

    protected function tearDown(): void
    {
        unlink($this->folder.'/manifest.json');
        rmdir($this->folder);
        parent::tearDown();
    }

    private function requestData(): array
    {
        return ['mode' => 'driving', 'start' => ['lon' => 92.86, 'lat' => 56.01],
            'places' => [['lon' => 92.861, 'lat' => 56.01, 'label' => 'Работа']]];
    }

    private function route(array $start = [92.86, 56.01], array $target = [92.861, 56.01]): array
    {
        return ['code' => 'Ok', 'routes' => [['distance' => 70, 'duration' => 12,
            'geometry' => ['type' => 'LineString', 'coordinates' => [$start, $target]],
            'legs' => [['annotation' => ['nodes' => [1, 2]]]]]]];
    }

    public function test_guests_get_versioned_static_car_estimate_and_both_original_points(): void
    {
        Http::fake(['local-router:5000/*' => Http::response($this->route())]);
        $response = $this->postJson('/api/v1/trips/analyze', $this->requestData())->assertOk()
            ->assertHeader('Cache-Control', 'no-store, private')
            ->assertJsonPath('results.0.status', 'AVAILABLE')->assertJsonPath('results.0.metrics.distance.value', 70)
            ->assertJsonPath('results.0.metrics.duration.value', 12)->assertJsonPath('results.0.metrics.duration.quality.freshness', 'UNKNOWN')
            ->assertJsonPath('source.dataset_version', 'test')->assertJsonPath('source.observed_at', null);
        $this->assertSame($this->requestData()['start'], $response->json('results.0.start'));
        $this->assertSame($this->requestData()['start'], $response->json('results.0.snaps.start.original'));
        $this->assertGuest();
        Http::assertSent(fn ($request) => str_contains($request->url(), 'radiuses=0.25%3B0.25') || str_contains($request->url(), 'radiuses=0.25;0.25'));
    }

    public function test_both_snaps_are_checked_and_an_error_does_not_remove_other_pairs(): void
    {
        Http::fakeSequence()->push($this->route())->push($this->route(target: [92.87, 56.01]))->push(['code' => 'NoRoute'], 400);
        $data = $this->requestData();
        $data['places'] = array_fill(0, 3, $data['places'][0]);
        $response = $this->postJson('/api/v1/trips/analyze', $data)->assertOk()
            ->assertJsonPath('results.0.status', 'AVAILABLE')->assertJsonPath('results.1.status', 'NEEDS_REFINEMENT')
            ->assertJsonPath('results.2.status', 'NO_PATH');
        foreach ([1, 2] as $index) {
            $this->assertNull($response->json("results.{$index}.route"));
            $this->assertNull($response->json("results.{$index}.metrics.distance.value"));
            $this->assertNull($response->json("results.{$index}.metrics.duration.value"));
        }
        $this->assertNull($response->json('results.1.snaps'));
    }

    public function test_distant_start_is_also_rejected(): void
    {
        Http::fake(['*' => Http::response($this->route(start: [92.87, 56.01]))]);
        $this->postJson('/api/v1/trips/analyze', $this->requestData())->assertOk()->assertJsonPath('results.0.status', 'NEEDS_REFINEMENT')->assertJsonPath('results.0.route', null);
    }

    public function test_unknown_road_point_and_container_failure_never_become_zero(): void
    {
        Http::fakeSequence()->push(['code' => 'NoSegment'], 400)->pushResponse(Http::failedConnection());
        $data = $this->requestData();
        $data['places'][] = $data['places'][0];
        $this->postJson('/api/v1/trips/analyze', $data)->assertOk()
            ->assertJsonPath('results.0.status', 'NEEDS_REFINEMENT')->assertJsonPath('results.1.status', 'UNAVAILABLE')
            ->assertJsonPath('results.0.checks.0', 'SNAP_NO_SAFE_CANDIDATE')->assertJsonPath('results.1.checks.0', 'ROUTER_UNAVAILABLE')
            ->assertJsonPath('results.0.metrics.duration.value', null)->assertJsonPath('results.1.route', null);
    }

    public function test_bad_snapshot_and_outside_pilot_never_call_a_router(): void
    {
        Http::fake();
        $data = $this->requestData();
        $data['start']['lon'] = 91;
        $this->postJson('/api/v1/trips/analyze', $data)->assertOk()->assertJsonPath('results.0.status', 'OUTSIDE_PILOT')->assertJsonPath('results.0.route', null)
            ->assertJsonPath('results.0.checks.0', 'OUTSIDE_CONFIRMED_COVERAGE');
        config(['routing.manifest_sha256' => str_repeat('0', 64)]);
        $this->postJson('/api/v1/trips/analyze', $this->requestData())->assertOk()->assertJsonPath('results.0.status', 'UNAVAILABLE')->assertJsonPath('source', null);
        Http::assertNothingSent();
    }

    public function test_diagnostics_localize_only_proven_endpoints_and_preserve_the_legacy_contract(): void
    {
        Http::fakeSequence()->push($this->route(target: [92.87, 56.01]))->push(['code' => 'NoSegment'], 400)->pushResponse(Http::failedConnection());
        $data = $this->requestData();
        $data['places'] = array_fill(0, 3, $data['places'][0]);
        $response = $this->postJson('/api/v1/trips/analyze', $data)->assertOk()
            ->assertJsonPath('results.0.diagnostics.version', 1)
            ->assertJsonPath('results.0.diagnostics.issues.0.code', 'ROUTER_ENDPOINT_MISMATCH')
            ->assertJsonPath('results.0.diagnostics.issues.0.location', 'target')
            ->assertJsonPath('results.0.diagnostics.issues.0.target_index', 0)
            ->assertJsonPath('results.1.diagnostics.issues.0.code', 'ROUTER_NO_SEGMENT')
            ->assertJsonPath('results.1.diagnostics.issues.0.location', 'unknown')
            ->assertJsonPath('results.1.diagnostics.issues.0.target_index', null)
            ->assertJsonPath('results.2.diagnostics.issues.0.location', 'unknown')
            ->assertJsonPath('results.2.road_choices.start.status', 'SELECTED')
            ->assertJsonPath('results.2.road_choices.target.status', 'SELECTED')
            ->assertJsonPath('results.2.checks.0', 'ROUTER_UNAVAILABLE');
        foreach ([0, 1, 2] as $i) {
            $this->assertNull($response->json("results.$i.route"));
            $this->assertNull($response->json("results.$i.metrics.distance.value"));
        }
    }

    public function test_scope_diagnostics_name_both_endpoints_and_the_correct_target(): void
    {
        Http::fake();
        $data = $this->requestData();
        $data['places'][] = ['lon' => 91, 'lat' => 56];
        $this->postJson('/api/v1/trips/analyze', $data)->assertOk()
            ->assertJsonPath('results.1.diagnostics.issues.0.location', 'target')
            ->assertJsonPath('results.1.diagnostics.issues.0.target_index', 1);
        $data['start']['lon'] = 91;
        $this->postJson('/api/v1/trips/analyze', $data)->assertOk()
            ->assertJsonPath('results.0.diagnostics.issues.0.location', 'start')
            ->assertJsonPath('results.0.diagnostics.issues.0.target_index', null)
            ->assertJsonPath('results.1.diagnostics.issues.0.location', 'both_endpoints')
            ->assertJsonPath('results.1.diagnostics.issues.0.target_index', 1);
    }

    public function test_a_failed_snap_check_is_localized_without_discarding_the_other_endpoint_or_guessing_access(): void
    {
        $this->mock(RoutingGeometryGuard::class, function ($mock) {
            $mock->shouldReceive('scope')->andReturn(true);
            $mock->shouldReceive('resolve')->andReturnUsing(function ($snapshot, $point) {
                if ($point['lon'] === 92.86) {
                    throw new \RuntimeException('Synthetic internal error');
                }

                return ['status' => 'SELECTED', 'point' => $point, 'candidates' => []];
            });
        });
        Http::fake();
        $this->postJson('/api/v1/trips/analyze', $this->requestData())->assertOk()
            ->assertJsonPath('results.0.status', 'UNKNOWN')
            ->assertJsonPath('results.0.diagnostics.issues.0.location', 'start')
            ->assertJsonPath('results.0.diagnostics.issues.0.category', 'check_failure')
            ->assertJsonPath('results.0.diagnostics.issues.0.code', 'SNAP_CHECK_FAILED')
            ->assertJsonPath('results.0.road_choices.target.status', 'SELECTED')
            ->assertJsonPath('results.0.route', null)
            ->assertDontSee('Synthetic internal error');
        Http::assertNothingSent();
    }

    public function test_body_modes_and_matrix_size_are_bounded(): void
    {
        Http::fake();
        $data = $this->requestData();
        $this->postJson('/api/v1/trips/analyze', [...$data, 'mode' => 'cycling'])->assertUnprocessable();
        $this->postJson('/api/v1/trips/analyze', [...$data, 'places' => array_fill(0, 4, $data['places'][0])])->assertUnprocessable();
        $data['start']['lon'] = 181;
        $this->postJson('/api/v1/trips/analyze', $data)->assertUnprocessable();
        $this->postJson('/api/v1/trips/analyze', ['padding' => str_repeat('x', 9000)])->assertStatus(413);
        Http::assertNothingSent();
    }

    public function test_malformed_or_oversized_response_cannot_publish_a_route(): void
    {
        Http::fakeSequence()->push('not-json')->push(str_repeat(' ', 1_000_001));
        $data = $this->requestData();
        $data['places'][] = $data['places'][0];
        $this->postJson('/api/v1/trips/analyze', $data)->assertOk()->assertJsonPath('results.0.status', 'UNKNOWN')
            ->assertJsonPath('results.1.status', 'UNKNOWN')->assertJsonPath('results.0.route', null)->assertJsonPath('results.1.metrics.distance.value', null);
    }

    public function test_trip_page_and_direct_link_are_public(): void
    {
        $this->withoutVite();
        $this->get('/trips')->assertOk()->assertViewIs('welcome');
        $this->get('/trips?trip=invalid')->assertOk()->assertViewIs('welcome');
    }

    public function test_unconfirmed_territory_is_rejected_before_network_even_inside_graph_bbox(): void
    {
        Http::fake();
        $this->mock(RoutingGeometryGuard::class, fn ($mock) => $mock->shouldReceive('scope')->andReturn(false));
        $this->postJson('/api/v1/trips/analyze', $this->requestData())->assertOk()
            ->assertJsonPath('results.0.status', 'OUTSIDE_PILOT')->assertJsonPath('results.0.route', null);
        Http::assertNothingSent();
    }

    public function test_zero_line_after_snapping_different_points_is_not_zero_travel_time(): void
    {
        $body = $this->route(target: [92.86, 56.01]);
        $body['routes'][0]['distance'] = 0;
        $body['routes'][0]['duration'] = 0;
        Http::fake(['*' => Http::response($body)]);
        $data = $this->requestData();
        $data['places'][0]['lon'] = 92.8602;
        $this->postJson('/api/v1/trips/analyze', $data)->assertOk()
            ->assertJsonPath('results.0.status', 'NEEDS_REFINEMENT')->assertJsonPath('results.0.metrics.duration.value', null);
    }

    public function test_access_guard_refusals_have_no_values_and_preserve_another_success(): void
    {
        // Entirely invented input, mocked snapshot/HTTP: no real coordinates/router.
        $manifest = json_decode(file_get_contents($this->folder.'/manifest.json'), true);
        $manifest['bbox'] = [-1, -1, 1, 1];
        $raw = json_encode($manifest);
        file_put_contents($this->folder.'/manifest.json', $raw);
        config(['routing.manifest_sha256' => hash('sha256', $raw)]);
        $this->mock(RoutingGeometryGuard::class, function ($mock) {
            $mock->shouldReceive('scope')->andReturn(true);
            $mock->shouldReceive('resolve')->andReturnUsing(fn ($snapshot, $point) => ['status' => 'SELECTED', 'point' => $point, 'candidates' => []]);
            $mock->shouldReceive('review')->andReturn(
                ['status' => 'AVAILABLE', 'reason' => 'Synthetic public edge', 'checks' => []],
                ['status' => 'UNKNOWN', 'reason' => 'Synthetic private node', 'checks' => ['SOURCE_NODE_ACCESS_UNKNOWN']],
                ['status' => 'UNKNOWN', 'reason' => 'Synthetic short private edge', 'checks' => ['SOURCE_EDGE_ACCESS_UNKNOWN']],
            );
        });
        $route = $this->route([0, 0], [.001, 0]);
        $route['routes'][0]['distance'] = 111;
        Http::fake(['*' => Http::response($route)]);
        $response = $this->postJson('/api/v1/trips/analyze', ['mode' => 'driving', 'start' => ['lon' => 0, 'lat' => 0],
            'places' => array_fill(0, 3, ['lon' => .001, 'lat' => 0, 'label' => 'Synthetic'])])->assertOk()
            ->assertJsonPath('results.0.status', 'AVAILABLE')->assertJsonPath('results.1.status', 'UNKNOWN')->assertJsonPath('results.2.status', 'UNKNOWN');
        foreach ([1, 2] as $index) {
            $this->assertNull($response->json("results.{$index}.route"));
            foreach (['distance', 'duration'] as $metric) {
                $this->assertNull($response->json("results.{$index}.metrics.{$metric}.value"));
                $this->assertNull($response->json("results.{$index}.metrics.{$metric}.quality.method"));
            }
        }
    }

    public function test_building_originals_and_manual_choices_are_distinct_from_router_inputs(): void
    {
        $this->mock(RoutingGeometryGuard::class, function ($mock) {
            $mock->shouldReceive('scope')->andReturn(true);
            $mock->shouldReceive('resolve')->andReturnUsing(function ($snapshot, $point, $hint) {
                $road = $hint ?? ['lon' => $point['lon'], 'lat' => $point['lat'] + .0001];

                return ['status' => 'SELECTED', 'point' => $road, 'candidates' => [['point' => $road, 'distance_m' => 11.1]]];
            });
            $mock->shouldReceive('review')->once()->withArgs(fn ($snapshot, $line, $a, $b, $nodes) => $a === $this->requestData()['start'] && $a['lat'] !== $line['coordinates'][0][1])
                ->andReturn(['status' => 'AVAILABLE', 'reason' => 'Synthetic checked connector', 'checks' => []]);
        });
        Http::fake(['*' => Http::response($this->route([92.86, 56.0101], [92.861, 56.0101]))]);
        $data = $this->requestData();
        $data['places'][0]['road'] = ['lon' => 92.861, 'lat' => 56.0101];
        $this->postJson('/api/v1/trips/analyze', $data)->assertOk()->assertJsonPath('results.0.status', 'AVAILABLE')
            ->assertJsonPath('results.0.start.lat', 56.01)->assertJsonPath('results.0.snaps.start.original.lat', 56.01)
            ->assertJsonPath('results.0.snaps.start.matched.lat', 56.0101)->assertJsonPath('results.0.road_choices.target.point.lat', 56.0101);
        Http::assertSent(fn ($r) => str_contains($r->url(), '/92.86,56.0101;92.861,56.0101?'));
    }

    public function test_ambiguous_pair_has_no_line_or_metrics_and_does_not_hide_another_success(): void
    {
        $this->mock(RoutingGeometryGuard::class, function ($mock) {
            $mock->shouldReceive('scope')->andReturn(true);
            $mock->shouldReceive('resolve')->andReturnUsing(fn ($snapshot, $p) => $p['lon'] === 92.862
                ? ['status' => 'CHOOSE', 'point' => null, 'candidates' => [['point' => $p, 'distance_m' => 8], ['point' => ['lon' => 92.8621, 'lat' => $p['lat']], 'distance_m' => 8.5]]]
                : ['status' => 'SELECTED', 'point' => $p, 'candidates' => []]);
            $mock->shouldReceive('review')->andReturn(['status' => 'AVAILABLE', 'reason' => 'Synthetic', 'checks' => []]);
        });
        Http::fake(['*' => Http::response($this->route())]);
        $data = $this->requestData();
        $data['places'][] = ['lon' => 92.862, 'lat' => 56.01, 'label' => 'Synthetic alternatives'];
        $this->postJson('/api/v1/trips/analyze', $data)->assertOk()->assertJsonPath('results.0.status', 'AVAILABLE')
            ->assertJsonPath('results.1.status', 'NEEDS_REFINEMENT')->assertJsonPath('results.1.route', null)
            ->assertJsonPath('results.1.metrics.distance.value', null)->assertJsonPath('results.1.metrics.duration.value', null)
            ->assertJsonCount(2, 'results.1.road_choices.target.candidates');
        Http::assertSentCount(1);
    }

    public function test_router_cannot_switch_a_selected_point_even_within_the_old_35m_radius(): void
    {
        Http::fake(['*' => Http::response($this->route(target: [92.86101, 56.01]))]);
        $this->postJson('/api/v1/trips/analyze', $this->requestData())->assertOk()
            ->assertJsonPath('results.0.status', 'NEEDS_REFINEMENT')->assertJsonPath('results.0.route', null)
            ->assertJsonPath('results.0.metrics.duration.value', null);
        Http::fake();
        $data = $this->requestData();
        $data['start']['road'] = ['lon' => 0];
        $this->postJson('/api/v1/trips/analyze', $data)->assertUnprocessable();
        Http::assertNothingSent();
    }

    public function test_no_safe_candidate_never_queries_router_and_gives_a_simple_action(): void
    {
        $this->mock(RoutingGeometryGuard::class, function ($mock) {
            $mock->shouldReceive('scope')->andReturn(true);
            $mock->shouldReceive('resolve')->andReturn(['status' => 'NONE', 'point' => null, 'candidates' => []]);
        });
        Http::fake();
        $response = $this->postJson('/api/v1/trips/analyze', $this->requestData())->assertOk()
            ->assertJsonPath('results.0.status', 'NEEDS_REFINEMENT')->assertJsonPath('results.0.route', null)
            ->assertJsonPath('results.0.metrics.duration.value', null);
        $this->assertStringContainsString('ближе к нужному подъезду или проезду', $response->json('results.0.reason'));
        Http::assertNothingSent();
    }
}
