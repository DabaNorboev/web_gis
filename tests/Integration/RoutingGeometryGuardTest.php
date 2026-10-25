<?php

namespace Tests\Integration;

use App\Services\Routing\RoutingGeometryGuard;
use App\Services\Routing\RoutingSnapshot;
use Tests\PostgisTestCase as TestCase;

// Only CTE SELECTs with synthetic geometry: no fixtures, migrations or table writes.
class RoutingGeometryGuardTest extends TestCase
{
    protected const READ_ONLY = true;

    private function review(array $extra = [], array $tags = [], ?array $start = null): array
    {
        $line = ['type' => 'LineString', 'coordinates' => [[92.86, 56.01], [92.861, 56.01]]];
        $road = ['id' => 'way/1', 'kind' => 'line', 'tags' => ['highway' => 'residential', ...$tags], 'nodes' => [1, 2], 'geometry' => $line];
        $snapshot = \Mockery::mock(RoutingSnapshot::class);
        $snapshot->shouldReceive('features')->andReturn([$road, ...$extra]);
        $snapshot->shouldReceive('manifest')->andReturn(['bbox' => [92.7, 55.9, 93.2, 56.2], 'boundary_margin_m' => 1000,
            'guard_sources' => ['service_geometry' => ['type' => 'Polygon', 'coordinates' => [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]]]]);

        return app(RoutingGeometryGuard::class)->review($snapshot, $line, $start ?? ['lon' => 92.86, 'lat' => 56.01], ['lon' => 92.861, 'lat' => 56.01], [1, 2]);
    }

    public function test_source_road_is_accepted_but_vehicle_private_and_indoor_are_not(): void
    {
        $this->assertSame('AVAILABLE', $this->review()['status']);
        $this->assertSame('UNKNOWN', $this->review(tags: ['vehicle' => 'private'])['status']);
        $this->assertSame('UNKNOWN', $this->review(tags: ['indoor' => 'yes'])['status']);
        $this->assertSame('UNKNOWN', $this->review(tags: ['oneway' => '-1'])['status']);
        $this->assertSame('UNKNOWN', $this->review(tags: ['access:conditional' => 'no @ (Mo-Fr)'])['status']);
    }

    public function test_short_snap_through_a_wall_requires_explicit_refinement(): void
    {
        $wall = ['id' => 'way/2', 'kind' => 'line', 'tags' => ['barrier' => 'wall'], 'nodes' => [3, 4],
            'geometry' => ['type' => 'LineString', 'coordinates' => [[92.859925, 56.0099], [92.859925, 56.0101]]]];
        $result = $this->review([$wall], start: ['lon' => 92.85985, 'lat' => 56.01]);
        $this->assertSame('NEEDS_REFINEMENT', $result['status']);
        $this->assertContains('SNAP_THROUGH_BARRIER', $result['checks']);
    }

    public function test_railway_levels_are_not_flat_connections(): void
    {
        $rail = ['id' => 'way/2', 'kind' => 'line', 'tags' => ['railway' => 'rail', 'bridge' => 'yes', 'layer' => '1'], 'nodes' => [3, 4],
            'geometry' => ['type' => 'LineString', 'coordinates' => [[92.8605, 56.009], [92.8605, 56.011]]]];
        $this->assertSame('AVAILABLE', $this->review([$rail])['status']);
        $rail['tags']['layer'] = '0';
        $this->assertSame('UNKNOWN', $this->review([$rail])['status']);
    }

    public function test_only_an_annotated_bridge_with_explicit_different_levels_clears_a_wall_crossing(): void
    {
        $wall = ['id' => 'way/2', 'kind' => 'line', 'tags' => ['barrier' => 'wall', 'layer' => '0'], 'nodes' => [3, 4],
            'geometry' => ['type' => 'LineString', 'coordinates' => [[92.8605, 56.009], [92.8605, 56.011]]]];
        $bridge = ['bridge' => 'yes', 'layer' => '1'];
        $this->assertSame('AVAILABLE', $this->review([$wall], $bridge)['status']);
        foreach ([['bridge' => 'yes', 'layer' => '0'], ['bridge' => 'yes'], ['layer' => '1'], ['bridge' => 'yes', 'layer' => 'unknown']] as $tags) {
            $this->assertContains('ROUTE_BARRIER_REVIEW', $this->review([$wall], $tags)['checks']);
        }
        unset($wall['tags']['layer']);
        $this->assertContains('ROUTE_BARRIER_REVIEW', $this->review([$wall], $bridge)['checks']);
        $wall['tags']['layer'] = '0';
        $wall['nodes'] = [1, 4]; // Contradictory topology: a connection cannot be dismissed by layer.
        $this->assertContains('ROUTE_BARRIER_REVIEW', $this->review([$wall], $bridge)['checks']);
    }

    public function test_nearby_untraversed_bridge_does_not_clear_a_ground_level_wall(): void
    {
        $wall = ['id' => 'way/20', 'kind' => 'line', 'tags' => ['barrier' => 'wall', 'layer' => '0'], 'nodes' => [31, 32],
            'geometry' => ['type' => 'LineString', 'coordinates' => [[93.01025, 56.1099], [93.01025, 56.1101]]]];
        $bridge = $this->road([21, 22, 23], ['bridge' => 'yes', 'layer' => '1']);
        $bridge['id'] = 'way/21';
        $result = $this->network([$this->road(), $bridge, $wall], [11, 12, 13]);
        $this->assertContains('ROUTE_BARRIER_REVIEW', $result['checks']);
        $this->assertSame('route', $result['diagnostic_issues'][0]['location']);
    }

    public function test_bridge_exception_does_not_clear_private_access_or_the_connector(): void
    {
        $wall = ['id' => 'way/2', 'kind' => 'line', 'tags' => ['barrier' => 'wall', 'layer' => '0'], 'nodes' => [3, 4],
            'geometry' => ['type' => 'LineString', 'coordinates' => [[92.8605, 56.009], [92.8605, 56.011]]]];
        $this->assertContains('SOURCE_EDGE_ACCESS_UNKNOWN', $this->review([$wall], ['bridge' => 'yes', 'layer' => '1', 'vehicle' => 'private'])['checks']);
        $wall['geometry']['coordinates'] = [[92.859925, 56.0099], [92.859925, 56.0101]];
        $result = $this->review([$wall], ['bridge' => 'yes', 'layer' => '1'], ['lon' => 92.85985, 'lat' => 56.01]);
        $this->assertContains('SNAP_THROUGH_BARRIER', $result['checks']);
        $issue = array_values(array_filter($result['diagnostic_issues'], fn ($i) => $i['code'] === 'SNAP_THROUGH_BARRIER'))[0];
        $this->assertSame('start', $issue['location']);
        $this->assertSame('connector', $issue['stage']);
    }

    public function test_a_point_inside_a_building_is_not_an_entrance(): void
    {
        $building = ['id' => 'way/3', 'kind' => 'building', 'geometry' => ['type' => 'Polygon',
            'coordinates' => [[[92.8599, 56.0099], [92.8601, 56.0099], [92.8601, 56.0101], [92.8599, 56.0101], [92.8599, 56.0099]]]]];
        $result = $this->review([$building]);
        $this->assertSame('NEEDS_REFINEMENT', $result['status']);
        $this->assertContains('SNAP_THROUGH_BUILDING', $result['checks']);
    }

    public function test_scope_checks_endpoints_and_the_metric_boundary_margin_before_routing(): void
    {
        $snapshot = \Mockery::mock(RoutingSnapshot::class);
        $snapshot->shouldReceive('manifest')->andReturn(['bbox' => [92.7, 55.9, 93.2, 56.2], 'boundary_margin_m' => 1000,
            'guard_sources' => ['service_geometry' => ['type' => 'Polygon', 'coordinates' => [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]]]]);
        $guard = app(RoutingGeometryGuard::class);
        $a = ['lon' => 92.86, 'lat' => 56.01];
        $this->assertTrue($guard->scope($snapshot, $a, ['lon' => 92.87, 'lat' => 56.02]));
        $this->assertFalse($guard->scope($snapshot, $a, ['lon' => 92.701, 'lat' => 56.01]));
        $this->assertFalse($guard->scope($snapshot, ['lon' => 91, 'lat' => 56], $a));
    }

    /** Invented geometry and node IDs only; never queries a router or data tables. */
    private function network(array $features, array $nodes, ?array $coordinates = null): array
    {
        $coordinates ??= [[93.01, 56.11], [93.011, 56.11]];
        $snapshot = \Mockery::mock(RoutingSnapshot::class);
        $snapshot->shouldReceive('features')->andReturn($features);
        $snapshot->shouldReceive('manifest')->andReturn(['bbox' => [92.7, 55.9, 93.2, 56.2], 'boundary_margin_m' => 1000,
            'guard_sources' => ['service_geometry' => ['type' => 'Polygon', 'coordinates' => [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]]]]);

        return app(RoutingGeometryGuard::class)->review($snapshot, ['type' => 'LineString', 'coordinates' => $coordinates],
            array_combine(['lon', 'lat'], $coordinates[0]), array_combine(['lon', 'lat'], $coordinates[array_key_last($coordinates)]), $nodes);
    }

    private function road(array $nodes = [11, 12, 13], array $tags = [], ?array $coordinates = null): array
    {
        return ['id' => 'way/11', 'kind' => 'line', 'nodes' => $nodes, 'tags' => ['highway' => 'residential', ...$tags],
            'geometry' => ['type' => 'LineString', 'coordinates' => $coordinates ?? [[93.01, 56.11], [93.0105, 56.11], [93.011, 56.11]]]];
    }

    public function test_private_gate_on_an_annotated_node_is_rejected_without_a_wall(): void
    {
        $gate = ['id' => 'node/12', 'kind' => 'node', 'tags' => ['barrier' => 'gate', 'vehicle' => 'private'],
            'geometry' => ['type' => 'Point', 'coordinates' => [93.0105, 56.11]]];
        $result = $this->network([$this->road(), $gate], [11, 12, 13]);
        $this->assertSame('UNKNOWN', $result['status']);
        $this->assertContains('SOURCE_NODE_ACCESS_UNKNOWN', $result['checks']);
        $gate['tags']['motorcar'] = 'yes';
        $this->assertSame('AVAILABLE', $this->network([$this->road(), $gate], [11, 12, 13])['status']);
        $gate['tags']['motorcar:conditional'] = 'yes @ (Mo-Fr)';
        $this->assertSame('UNKNOWN', $this->network([$this->road(), $gate], [11, 12, 13])['status']);
        unset($gate['tags']['motorcar:conditional']);
        unset($gate['tags']['vehicle'], $gate['tags']['motorcar']);
        $this->assertSame('UNKNOWN', $this->network([$this->road(), $gate], [11, 12, 13])['status']);
    }

    public function test_short_private_edge_is_rejected_by_source_ids_without_a_length_cutoff(): void
    {
        $mid = [93.01003, 56.11]; // About 1.87 m in this synthetic local geometry.
        $private = $this->road([11, 12], ['vehicle' => 'private'], [[93.01, 56.11], $mid]);
        $public = $this->road([12, 13], [], [$mid, [93.011, 56.11]]);
        $public['id'] = 'way/12';
        $result = $this->network([$private, $public], [11, 12, 13]);
        $this->assertSame('UNKNOWN', $result['status']);
        $this->assertContains('SOURCE_EDGE_ACCESS_UNKNOWN', $result['checks']);
        $private['tags']['motor_vehicle'] = 'yes';
        $this->assertSame('AVAILABLE', $this->network([$private, $public], [11, 12, 13])['status']);
    }

    public function test_access_hierarchy_and_applicable_conditions_remain_conservative(): void
    {
        foreach ([['motorcar' => 'yes', 'motor_vehicle' => 'private'], ['motor_vehicle' => 'yes', 'vehicle' => 'private'],
            ['vehicle' => 'yes', 'access' => 'private'], ['motorcar' => 'yes', 'vehicle:conditional' => 'no @ (Mo-Fr)']] as $tags) {
            $this->assertSame('AVAILABLE', $this->network([$this->road(tags: $tags)], [11, 12, 13])['status']);
        }
        foreach ([['motorcar' => 'private', 'access' => 'yes'], ['motorcar' => 'yes', 'motorcar:conditional' => 'no @ (Mo-Fr)'],
            ['vehicle:conditional' => 'yes @ (Mo-Fr)'], ['access' => 'destination']] as $tags) {
            $this->assertSame('UNKNOWN', $this->network([$this->road(tags: $tags)], [11, 12, 13])['status']);
        }
    }

    public function test_nearby_private_crossing_and_unrelated_gate_are_not_attributed_to_route(): void
    {
        $crossing = $this->road([21, 22], ['vehicle' => 'private'], [[93.0105, 56.1099], [93.0105, 56.1101]]);
        $crossing['id'] = 'way/21';
        $gate = ['id' => 'node/21', 'kind' => 'node', 'tags' => ['barrier' => 'gate', 'vehicle' => 'private'],
            'geometry' => ['type' => 'Point', 'coordinates' => [93.0105, 56.11]]];
        $this->assertSame('AVAILABLE', $this->network([$this->road(), $crossing, $gate], [11, 12, 13])['status']);
    }

    public function test_clipped_private_endpoint_edge_without_two_annotations_is_not_accepted(): void
    {
        $private = $this->road([10, 11], ['vehicle' => 'private'], [[93.0099, 56.11], [93.01, 56.11]]);
        $private['id'] = 'way/10';
        $coordinates = [[93.00997, 56.11], [93.01, 56.11], [93.0105, 56.11], [93.011, 56.11]];
        $result = $this->network([$private, $this->road()], [11, 12, 13], $coordinates);
        $this->assertSame('UNKNOWN', $result['status']);
        $this->assertContains('ENDPOINT_ACCESS_REVIEW', $result['checks']);
    }

    public function test_missing_annotations_cannot_turn_a_zero_line_into_confirmed_access(): void
    {
        $result = $this->network([$this->road(tags: ['vehicle' => 'private'])], [], [[93.01, 56.11], [93.01, 56.11]]);
        $this->assertSame('UNKNOWN', $result['status']);
        $this->assertContains('SOURCE_ANNOTATIONS_INSUFFICIENT', $result['checks']);
    }
}
