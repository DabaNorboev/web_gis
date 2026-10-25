<?php

namespace Tests\Integration;

use App\Services\Routing\LocalCarRouterProvider;
use App\Services\Routing\RoutingGeometryGuard;
use App\Services\Routing\RoutingSnapshot;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\PostgisTestCase as TestCase;

// Only SELECT/CTEs, synthetic features, READ ONLY. No tables/fixtures/migrations.
class RoutingSnapTest extends TestCase
{
    protected const READ_ONLY = true;

    private array $original = ['lon' => 93.01, 'lat' => 56.11];

    private function road(float $dy = .00015, array $tags = [], string $id = 'way/11', array $nodes = [11, 12]): array
    {
        return ['id' => $id, 'kind' => 'line', 'nodes' => $nodes, 'tags' => ['highway' => 'residential', ...$tags],
            'geometry' => ['type' => 'LineString', 'coordinates' => [[93.0097, 56.11 + $dy], [93.0103, 56.11 + $dy]]]];
    }

    private function building(float $low = -.00005, float $high = .00005): array
    {
        return ['id' => 'way/41', 'kind' => 'building', 'geometry' => ['type' => 'Polygon', 'coordinates' => [[
            [93.00995, 56.11 + $low], [93.01005, 56.11 + $low], [93.01005, 56.11 + $high], [93.00995, 56.11 + $high], [93.00995, 56.11 + $low],
        ]]]];
    }

    private function snapshot(array $features): RoutingSnapshot
    {
        $snapshot = \Mockery::mock(RoutingSnapshot::class);
        $snapshot->shouldReceive('features')->andReturn($features);
        $snapshot->shouldReceive('manifest')->andReturn(['bbox' => [92.7, 55.9, 93.2, 56.2], 'snap_limit_m' => 35, 'boundary_margin_m' => 1000,
            'guard_sources' => ['service_geometry' => ['type' => 'Polygon', 'coordinates' => [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]]]]);

        return $snapshot;
    }

    private function resolve(array $features, ?array $hint = null): array
    {
        return app(RoutingGeometryGuard::class)->resolve($this->snapshot($features), $this->original, $hint);
    }

    public function test_one_safe_road_outside_the_original_building_is_selected_and_full_guard_accepts(): void
    {
        $features = [$this->road(), $this->building()];
        $resolved = $this->resolve($features);
        $this->assertSame('SELECTED', $resolved['status']);
        $this->assertEqualsWithDelta(16.7, $resolved['candidates'][0]['distance_m'], .2);
        $point = $resolved['point'];
        $this->assertNotSame($this->original, $point);
        $result = app(RoutingGeometryGuard::class)->review($this->snapshot($features), ['type' => 'LineString',
            'coordinates' => [[$point['lon'], $point['lat']], [93.0102, 56.11015]]], $this->original, ['lon' => 93.0102, 'lat' => 56.11015], [11, 12]);
        $this->assertSame('AVAILABLE', $result['status']);
    }

    public function test_the_original_building_edge_is_consistent_with_its_centre_but_an_external_point_is_not(): void
    {
        $road = $this->road();
        // Original lies on the southern edge, so the connector exits through the building.
        $building = $this->building(0, .00005);
        $this->assertSame('SELECTED', $this->resolve([$road, $building])['status']);
        // An external point 2.2 mm before that edge must not gain the same permission.
        $building = $this->building(.00000002, .00005);
        $result = $this->resolve([$road, $building]);
        $this->assertSame('NONE', $result['status']);
        $this->assertContains('SNAP_THROUGH_BUILDING', $result['checks']);
    }

    public function test_equal_safe_sides_require_choice_and_an_explicit_choice_is_retained(): void
    {
        $features = [$this->road(), $this->road(-.00015, id: 'way/21', nodes: [21, 22]), $this->building()];
        $result = $this->resolve($features);
        $this->assertSame('CHOOSE', $result['status']);
        $this->assertCount(2, $result['candidates']);
        $this->assertNull($result['point']);
        $selected = $this->resolve($features, $result['candidates'][1]['point']);
        $this->assertSame('SELECTED', $selected['status']);
        $this->assertEqualsWithDelta($result['candidates'][1]['point']['lat'], $selected['point']['lat'], 1e-8);
    }

    public function test_parallel_source_ids_are_not_merged_even_within_geometry_tolerance(): void
    {
        $result = $this->resolve([$this->road(.000001), $this->road(-.000001, id: 'way/21', nodes: [21, 22])]);
        $this->assertSame('CHOOSE', $result['status']);
        $this->assertCount(2, $result['candidates']);
    }

    public function test_other_carriageway_cannot_be_reached_across_the_nearer_road(): void
    {
        $result = $this->resolve([$this->road(), $this->road(.00025, id: 'way/21', nodes: [21, 22])], ['lon' => 93.01, 'lat' => 56.11025]);
        $this->assertSame('NONE', $result['status']);
    }

    public function test_private_gate_wall_water_railway_and_other_building_block_the_connector(): void
    {
        $line = ['type' => 'LineString', 'coordinates' => [[93.0099, 56.1101], [93.0101, 56.1101]]];
        $obstacles = [
            ['id' => 'node/31', 'kind' => 'node', 'tags' => ['barrier' => 'gate', 'vehicle' => 'private'], 'geometry' => ['type' => 'Point', 'coordinates' => [93.01, 56.1101]]],
            ['id' => 'way/32', 'kind' => 'line', 'tags' => ['barrier' => 'wall'], 'geometry' => $line],
            ['id' => 'way/33', 'kind' => 'line', 'tags' => ['railway' => 'rail'], 'geometry' => $line],
            $this->building(.00007, .00012),
            ['id' => 'way/34', 'kind' => 'water', 'geometry' => $this->building(.00007, .00012)['geometry']],
        ];
        foreach ($obstacles as $obstacle) {
            $this->assertSame('NONE', $this->resolve([$this->road(), $obstacle])['status']);
        }
        $gate = $obstacles[0];
        $gate['tags']['motorcar'] = 'yes';
        $this->assertSame('SELECTED', $this->resolve([$this->road(), $gate])['status']);
    }

    public function test_private_short_road_conditions_and_empty_or_far_network_are_not_candidates(): void
    {
        foreach ([['vehicle' => 'private'], ['motorcar:conditional' => 'yes @ (Mo-Fr)'], ['indoor' => 'yes']] as $tags) {
            $this->assertSame('NONE', $this->resolve([$this->road(tags: $tags)])['status']);
        }
        $short = $this->road(tags: ['vehicle' => 'private']);
        $short['geometry']['coordinates'] = [[93.01, 56.11015], [93.01003, 56.11015]];
        $this->assertSame('NONE', $this->resolve([$short])['status']);
        $this->assertSame('NONE', $this->resolve([])['status']);
        $this->assertSame('NONE', $this->resolve([$this->road(.00033)])['status']);
        $this->assertSame('SELECTED', $this->resolve([$this->road(.0003)])['status']);
        $this->assertSame('SELECTED', $this->resolve([$this->road(tags: ['vehicle' => 'private', 'motorcar' => 'yes'])])['status']);
    }

    public function test_manual_outside_pilot_or_beyond_35m_cannot_bypass_checks(): void
    {
        $outside = $this->resolve([$this->road()], ['lon' => 92.701, 'lat' => 56.11]);
        $this->assertSame('NONE', $outside['status']);
        $this->assertContains('OUTSIDE_CONFIRMED_COVERAGE', $outside['checks']);
        $this->assertSame('NONE', $this->resolve([$this->road()], ['lon' => 93.01, 'lat' => 56.1104])['status']);
    }

    public function test_leaving_and_reentering_the_same_concave_building_is_not_accepted(): void
    {
        $building = $this->building();
        $shape = [[-.0001, -.00005], [.0001, -.00005], [.0001, .00004], [-.00004, .00004], [-.00004, .00008], [.0001, .00008], [.0001, .00012], [-.0001, .00012], [-.0001, -.00005]];
        $building['geometry']['coordinates'] = [array_map(fn ($p) => [93.01 + $p[0], 56.11 + $p[1]], $shape)];
        $this->assertSame('NONE', $this->resolve([$this->road(), $building])['status']);
    }

    public function test_equal_distance_band_is_one_metre_and_search_budget_never_truncates_to_success(): void
    {
        $this->assertSame('CHOOSE', $this->resolve([$this->road(), $this->road(-.000155, id: 'way/21', nodes: [21, 22])])['status']);
        $this->assertSame('SELECTED', $this->resolve([$this->road(), $this->road(-.000162, id: 'way/21', nodes: [21, 22])])['status']);
        $many = [];
        for ($i = 0; $i < 17; $i++) {
            $many[] = $this->road(($i - 8) * .0000004, id: 'way/'.(100 + $i), nodes: [1000 + $i * 2, 1001 + $i * 2]);
        }
        $this->assertSame('NONE', $this->resolve($many)['status']);
    }

    public function test_adjacent_ways_at_the_same_source_junction_are_one_candidate(): void
    {
        $a = $this->road();
        $a['geometry']['coordinates'][0] = [93.01, 56.11015];
        $b = $this->road(id: 'way/21', nodes: [11, 22]);
        $b['geometry']['coordinates'] = [[93.01, 56.11015], [93.01, 56.1104]];
        $this->assertSame('SELECTED', $this->resolve([$a, $b])['status']);
    }

    public function test_two_local_minima_on_one_hairpin_way_are_not_a_single_candidate(): void
    {
        $road = $this->road(nodes: [11, 12, 13, 14]);
        $road['geometry']['coordinates'] = [[93.0097, 56.10985], [93.0103, 56.10985], [93.0103, 56.11015], [93.0097, 56.11015]];
        $this->assertSame('CHOOSE', $this->resolve([$road])['status']);
        $road['nodes'] = range(11, 31);
        $road['geometry']['coordinates'] = array_map(fn ($i) => [93.0097 + $i * .00003, 56.11015], range(0, 20));
        $this->assertSame('SELECTED', $this->resolve([$road])['status']);
    }

    public function test_provider_chain_uses_checked_road_points_and_wall_recheck_prevents_any_route(): void
    {
        $features = [$this->road(), $this->building()];
        $snapshot = \Mockery::mock(RoutingSnapshot::class);
        $snapshot->shouldReceive('features')->andReturnUsing(function () use (&$features) {
            return $features;
        });
        $snapshot->shouldReceive('contains')->andReturn(true);
        $snapshot->shouldReceive('manifest')->andReturn(['version' => 'synthetic', 'engine_version' => '5.27.1',
            'pbf_sha256' => str_repeat('a', 64), 'extract_sha256' => str_repeat('b', 64), 'observed_at' => null, 'prepared_at' => null,
            'bbox' => [92.7, 55.9, 93.2, 56.2], 'snap_limit_m' => 35, 'boundary_margin_m' => 1000,
            'guard_sources' => ['imports' => [], 'service_geometry' => ['type' => 'Polygon', 'coordinates' => [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]]]]);
        Http::preventStrayRequests();
        Http::fake(['*' => Http::response(['code' => 'Ok', 'routes' => [[
            'distance' => 12.44, 'duration' => 3, 'geometry' => ['type' => 'LineString', 'coordinates' => [[93.01, 56.11015], [93.0102, 56.11015]]],
            'legs' => [['annotation' => ['nodes' => [11, 12]]]],
        ]]])]);
        $provider = new LocalCarRouterProvider($snapshot, app(RoutingGeometryGuard::class));
        $places = [['lon' => 93.0102, 'lat' => 56.11, 'label' => 'Synthetic target']];
        $response = $provider->analyze($this->original, $places);
        $this->assertSame('AVAILABLE', $response['results'][0]['status']);
        $this->assertSame($this->original, $response['results'][0]['snaps']['start']['original']);
        $this->assertEqualsWithDelta(56.11015, $response['results'][0]['snaps']['start']['matched']['lat'], 1e-8);
        $this->assertEqualsWithDelta(12.44, $response['results'][0]['route']['distance_m'], .01);
        Http::assertSentCount(1);
        $features[] = ['id' => 'way/99', 'kind' => 'line', 'tags' => ['barrier' => 'wall'],
            'geometry' => ['type' => 'LineString', 'coordinates' => [[93.0099, 56.1101], [93.0103, 56.1101]]]];
        Http::fake();
        $response = $provider->analyze($this->original, $places);
        $this->assertSame('NEEDS_REFINEMENT', $response['results'][0]['status']);
        $this->assertNull($response['results'][0]['route']);
        $this->assertNull($response['results'][0]['metrics']['duration']['value']);
        Http::assertNothingSent();
    }

    /** Only the snapshot data source is substituted; resolver, SQL and guard stay real. */
    private function providerFor(array $features): LocalCarRouterProvider
    {
        $connection = DB::selectOne("SELECT current_database() database_name, current_setting('transaction_read_only') read_only");
        $this->assertSame('web_gis_test', $connection->database_name);
        $this->assertSame('on', $connection->read_only);

        $snapshot = \Mockery::mock(RoutingSnapshot::class);
        $snapshot->shouldReceive('features')->andReturn($features);
        $snapshot->shouldReceive('contains')->andReturn(true);
        $snapshot->shouldReceive('manifest')->andReturn(['version' => 'synthetic', 'engine_version' => '5.27.1',
            'pbf_sha256' => str_repeat('a', 64), 'extract_sha256' => str_repeat('b', 64), 'observed_at' => null, 'prepared_at' => null,
            'bbox' => [92.7, 55.9, 93.2, 56.2], 'snap_limit_m' => 35, 'boundary_margin_m' => 1000,
            'guard_sources' => ['imports' => [], 'service_geometry' => ['type' => 'Polygon', 'coordinates' => [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]]]]);

        return new LocalCarRouterProvider($snapshot, app(RoutingGeometryGuard::class));
    }

    private function fakeSuccessfulRoute(array $coordinates, array $nodes): void
    {
        Http::preventStrayRequests();
        Http::fake(['*' => Http::response(['code' => 'Ok', 'routes' => [[
            'distance' => 12.44, 'duration' => 3, 'geometry' => ['type' => 'LineString', 'coordinates' => $coordinates],
            'legs' => [['annotation' => ['nodes' => $nodes]]],
        ]]])]);
    }

    private function assertNoRouteOrMetrics(array $row): void
    {
        $this->assertNull($row['route']);
        foreach (['distance', 'duration'] as $metric) {
            $this->assertNull($row['metrics'][$metric]['value']);
            $this->assertNull($row['metrics'][$metric]['quality']['method']);
        }
    }

    public function test_provider_rejects_private_gate_inside_a_successful_osrm_route(): void
    {
        $coordinates = [[93.01, 56.11015], [93.0101, 56.11015], [93.0102, 56.11015]];
        $road = $this->road(nodes: [10, 11, 12, 13, 14]);
        $road['geometry']['coordinates'] = [[93.0097, 56.11015], ...$coordinates, [93.0103, 56.11015]];
        $gate = ['id' => 'node/12', 'kind' => 'node', 'tags' => ['barrier' => 'gate', 'vehicle' => 'private'],
            'geometry' => ['type' => 'Point', 'coordinates' => $coordinates[1]]];
        $provider = $this->providerFor([$road, $this->building(), $gate]);
        $this->fakeSuccessfulRoute($coordinates, [11, 12, 13]);

        $row = $provider->analyze($this->original, [['lon' => 93.0102, 'lat' => 56.11, 'label' => 'Synthetic gate']])['results'][0];

        Http::assertSentCount(1);
        foreach (['start', 'target'] as $end) {
            $this->assertSame('SELECTED', $row['road_choices'][$end]['status']);
            $this->assertCount(1, $row['road_choices'][$end]['candidates']);
        }
        $this->assertSame('UNKNOWN', $row['status']);
        $this->assertContains('SOURCE_NODE_ACCESS_UNKNOWN', $row['checks']);
        $this->assertNoRouteOrMetrics($row);
    }

    public function test_provider_rejects_a_short_private_edge_inside_a_successful_osrm_route(): void
    {
        $coordinates = [[93.01, 56.11015], [93.01008, 56.11015], [93.01011, 56.11015], [93.0102, 56.11015]];
        $before = $this->road(nodes: [10, 11, 12]);
        $before['geometry']['coordinates'] = [[93.0097, 56.11015], $coordinates[0], $coordinates[1]];
        // About 1.87 m, strictly inside the route and away from both connectors.
        $private = $this->road(tags: ['vehicle' => 'private'], id: 'way/12', nodes: [12, 13]);
        $private['geometry']['coordinates'] = [$coordinates[1], $coordinates[2]];
        $after = $this->road(id: 'way/13', nodes: [13, 14, 15]);
        $after['geometry']['coordinates'] = [$coordinates[2], $coordinates[3], [93.0103, 56.11015]];
        $provider = $this->providerFor([$before, $private, $after, $this->building()]);
        $this->fakeSuccessfulRoute($coordinates, [11, 12, 13, 14]);

        $row = $provider->analyze($this->original, [['lon' => 93.0102, 'lat' => 56.11, 'label' => 'Synthetic short edge']])['results'][0];

        Http::assertSentCount(1);
        foreach (['start', 'target'] as $end) {
            $this->assertSame('SELECTED', $row['road_choices'][$end]['status']);
            $this->assertCount(1, $row['road_choices'][$end]['candidates']);
        }
        $this->assertSame('UNKNOWN', $row['status']);
        $this->assertContains('SOURCE_EDGE_ACCESS_UNKNOWN', $row['checks']);
        $this->assertNoRouteOrMetrics($row);
    }

    public function test_provider_requires_an_explicit_choice_without_calling_osrm_for_ambiguous_candidates(): void
    {
        $provider = $this->providerFor([$this->road(), $this->road(-.00015, id: 'way/21', nodes: [21, 22]), $this->building()]);
        $this->fakeSuccessfulRoute([[93.01, 56.11015], [93.0102, 56.11015]], [11, 12]);

        $row = $provider->analyze($this->original, [['lon' => 93.0102, 'lat' => 56.11, 'label' => 'Synthetic ambiguous']])['results'][0];

        $this->assertSame('NEEDS_REFINEMENT', $row['status']);
        foreach (['start', 'target'] as $end) {
            $this->assertSame('CHOOSE', $row['road_choices'][$end]['status']);
            $this->assertNull($row['road_choices'][$end]['point']);
            $this->assertCount(2, $row['road_choices'][$end]['candidates']);
        }
        $this->assertNoRouteOrMetrics($row);
        Http::assertNothingSent();
    }

    public function test_provider_refuses_without_calling_osrm_when_no_safe_candidate_exists(): void
    {
        $provider = $this->providerFor([$this->building()]);
        $this->fakeSuccessfulRoute([[93.01, 56.11015], [93.0102, 56.11015]], [11, 12]);

        $row = $provider->analyze($this->original, [['lon' => 93.0102, 'lat' => 56.11, 'label' => 'Synthetic absent']])['results'][0];

        $this->assertSame('NEEDS_REFINEMENT', $row['status']);
        foreach (['start', 'target'] as $end) {
            $this->assertSame('NONE', $row['road_choices'][$end]['status']);
            $this->assertNull($row['road_choices'][$end]['point']);
            $this->assertSame([], $row['road_choices'][$end]['candidates']);
        }
        $this->assertStringContainsString('не найдена', $row['reason']);
        $this->assertNoRouteOrMetrics($row);
        Http::assertNothingSent();
    }

    public function test_radius_and_missing_road_data_have_distinct_diagnostics_without_changing_the_limit(): void
    {
        $far = $this->resolve([$this->road(.0004)]);
        $this->assertSame('NONE', $far['status']);
        $this->assertContains('SNAP_RADIUS_EXCEEDED', $far['checks']);
        $this->assertSame(35, $far['diagnostics']['radius_m']);
        $this->assertGreaterThan(35, $far['diagnostics']['nearest_road_distance_m']);
        $this->assertSame(0, $far['diagnostics']['candidate_count']);
        $missing = $this->resolve([$this->building()]);
        $this->assertContains('SNAP_ROAD_DATA_MISSING', $missing['checks']);
        $this->assertNull($missing['diagnostics']['nearest_road_distance_m']);
        $this->assertSame('loaded_guard_cells', $missing['diagnostics']['nearest_road_scope']);
        $private = $this->resolve([$this->road(tags: ['vehicle' => 'private'])]);
        $this->assertContains('SNAP_ROAD_ACCESS_UNKNOWN', $private['checks']);
        $this->assertNotContains('SNAP_RADIUS_EXCEEDED', $private['checks']);
        $this->assertGreaterThan(0, $private['diagnostics']['candidate_count']);
        $this->assertSame(0, $private['diagnostics']['safe_candidate_count']);
    }

    public function test_reason_location_identifies_the_target_index_and_both_endpoints_only_with_evidence(): void
    {
        $provider = $this->providerFor([$this->road(), $this->building()]);
        Http::fake();
        $far = ['lon' => 93.01, 'lat' => 56.111];
        $near = ['lon' => 93.0102, 'lat' => 56.11];
        $row = $provider->analyze($this->original, [$far, $far])['results'][1];
        $this->assertSame('NEEDS_REFINEMENT', $row['status']);
        $this->assertSame('target', $row['diagnostics']['issues'][0]['location']);
        $this->assertSame(1, $row['diagnostics']['issues'][0]['target_index']);
        $this->assertSame('distance', $row['diagnostics']['issues'][0]['category']);
        $row = $provider->analyze($far, [$near])['results'][0];
        $this->assertSame('start', $row['diagnostics']['issues'][0]['location']);
        $this->assertNull($row['diagnostics']['issues'][0]['target_index']);
        $row = $provider->analyze($far, [$far])['results'][0];
        $this->assertSame('both_endpoints', $row['diagnostics']['issues'][0]['location']);
        $this->assertSame(0, $row['diagnostics']['issues'][0]['target_index']);
        $this->assertNoRouteOrMetrics($row);
        Http::assertNothingSent();
    }

    public function test_provider_preserves_osrm_distance_and_duration_without_adding_nonzero_connectors(): void
    {
        $provider = $this->providerFor([$this->road(), $this->building()]);
        $coordinates = [[93.01, 56.11015], [93.0102, 56.11015]];
        $target = ['lon' => 93.0102, 'lat' => 56.11];
        $this->fakeSuccessfulRoute($coordinates, [11, 12]);

        $row = $provider->analyze($this->original, [[...$target, 'label' => 'Synthetic metrics']])['results'][0];

        $this->assertSame('AVAILABLE', $row['status']);
        $this->assertSame($coordinates, $row['route']['geometry']['coordinates']);
        foreach (['start' => $this->original, 'target' => $target] as $end => $original) {
            $this->assertSame('SELECTED', $row['road_choices'][$end]['status']);
            $this->assertCount(1, $row['road_choices'][$end]['candidates']);
            $this->assertSame($original, $row['snaps'][$end]['original']);
            $this->assertNotSame($original, $row['snaps'][$end]['matched']);
            $this->assertGreaterThan(10, $row['snaps'][$end]['distance_m']);
        }
        $this->assertEqualsWithDelta(12.44, $row['route']['distance_m'], 1e-9);
        $this->assertEqualsWithDelta(3, $row['route']['duration_s'], 1e-9);
        $this->assertEqualsWithDelta(12.44, $row['metrics']['distance']['value'], 1e-9);
        $this->assertEqualsWithDelta(3, $row['metrics']['duration']['value'], 1e-9);
        Http::assertSentCount(1);
    }

    public function test_provider_explains_fence_and_absent_candidates_without_changing_the_refusal(): void
    {
        $fence = ['id' => 'way/99', 'kind' => 'line', 'tags' => ['barrier' => 'fence'],
            'geometry' => ['type' => 'LineString', 'coordinates' => [[93.0099, 56.1101], [93.0103, 56.1101]]]];
        foreach ([[$this->road(), $this->building(), $fence], []] as $i => $features) {
            $this->fakeSuccessfulRoute([[93.01, 56.11015], [93.0102, 56.11015]], [11, 12]);
            $row = $this->providerFor($features)->analyze($this->original, [['lon' => 93.0102, 'lat' => 56.11, 'label' => 'Synthetic reason']])['results'][0];
            $this->assertSame('NEEDS_REFINEMENT', $row['status']);
            $this->assertContains('SNAP_NO_SAFE_CANDIDATE', $row['checks']);
            $this->assertSame($i === 0, in_array('SNAP_THROUGH_BARRIER', $row['checks'], true));
            $this->assertNoRouteOrMetrics($row);
            Http::assertNothingSent();
        }
    }

    public function test_candidate_name_is_omitted_at_a_junction_with_different_source_names(): void
    {
        $a = $this->road(tags: ['name' => 'Synthetic north']);
        $a['geometry']['coordinates'][0] = [93.01, 56.11015];
        $b = $this->road(tags: ['name' => 'Synthetic junction'], id: 'way/21', nodes: [11, 22]);
        $b['geometry']['coordinates'] = [[93.01, 56.11015], [93.01, 56.1104]];
        $result = $this->resolve([$a, $b]);
        $this->assertSame('SELECTED', $result['status']);
        $this->assertCount(1, $result['candidates']);
        $this->assertArrayNotHasKey('name', $result['candidates'][0]);
    }

    public function test_both_ambiguous_sides_wait_for_explicit_selection_then_use_the_selected_road(): void
    {
        $north = $this->road(tags: ['name' => 'Synthetic north']);
        $south = $this->road(-.00015, ['name' => 'Synthetic south'], 'way/21', [21, 22]);
        $link = $this->road(id: 'way/31', nodes: [12, 22]);
        $link['geometry']['coordinates'] = [[93.0103, 56.11015], [93.0103, 56.10985]];
        $features = [$north, $south, $link, $this->building()];
        $start = ['lon' => 93.0103, 'lat' => 56.11];
        $target = [...$this->original, 'label' => 'Synthetic alternatives'];
        Http::preventStrayRequests();
        $response = [];
        Http::fake(['*' => function () use (&$response) {
            return Http::response($response);
        }]);
        $row = $this->providerFor($features)->analyze($start, [$target])['results'][0];
        $this->assertSame('NEEDS_REFINEMENT', $row['status']);
        $this->assertSame('CHOOSE', $row['road_choices']['target']['status']);
        $this->assertCount(2, $row['road_choices']['target']['candidates']);
        $this->assertNoRouteOrMetrics($row);
        Http::assertNothingSent();

        foreach ($row['road_choices']['target']['candidates'] as $i => $candidate) {
            $point = $candidate['point'];
            $isNorth = $point['lat'] > $this->original['lat'];
            $this->assertSame($isNorth ? 'Synthetic north' : 'Synthetic south', $candidate['name']);
            $response = ['code' => 'Ok', 'routes' => [[
                'distance' => 35.4, 'duration' => 6,
                'geometry' => ['type' => 'LineString', 'coordinates' => [[$start['lon'], $start['lat']], [93.0103, $point['lat']], [$point['lon'], $point['lat']]]],
                'legs' => [['annotation' => ['nodes' => $isNorth ? [22, 12, 11] : [12, 22, 21]]]],
            ]]];
            $selected = $this->providerFor($features)->analyze($start, [[...$target, 'road' => $point]])['results'][0];
            $this->assertSame('AVAILABLE', $selected['status'], $selected['reason'].' '.implode(', ', $selected['checks']));
            $this->assertSame(true, $selected['road_choices']['target']['manual']);
            $this->assertEqualsWithDelta($point['lat'], $selected['snaps']['target']['matched']['lat'], 1e-9);
            $this->assertSame($this->original, $selected['snaps']['target']['original']);
            Http::assertSentCount($i + 1);
        }
    }
}
