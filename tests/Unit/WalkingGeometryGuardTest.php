<?php

namespace Tests\Unit;

use App\Services\Routing\RoutingDataException;
use App\Services\Routing\WalkingGeometry as G;
use App\Services\Routing\WalkingGeometryGuard;
use App\Services\Routing\WalkingRoutingSnapshot;
use PHPUnit\Framework\TestCase;

/** Synthetic source rows only: no working DB, saved routes, or personal coordinates. */
class WalkingGeometryGuardTest extends TestCase
{
    private function p(float $x, float $y = 0): array
    {
        return [93 + $x / 62376, 56 + $y / 111300];
    }

    private function selected(float $x, float $y = 0): array
    {
        [$lon,$lat] = $this->p($x, $y);

        return compact('lon', 'lat');
    }

    private function way(int $id, array $nodes, array $points, array $tags = []): array
    {
        return ['id' => $id, 'nodes' => $nodes, 'coordinates' => array_map(fn ($p) => $this->p(...$p), $points), 'tags' => $tags + ['highway' => 'footway']];
    }

    private function line(array $way): array
    {
        return ['kind' => 'line', 'id' => 'way/'.$way['id'], 'tags' => $way['tags'], 'nodes' => $way['nodes'], 'geometry' => ['type' => 'LineString', 'coordinates' => $way['coordinates']]];
    }

    private function node(int $id, float $x, float $y, array $tags): array
    {
        return ['kind' => 'node', 'id' => 'node/'.$id, 'tags' => $tags, 'geometry' => ['type' => 'Point', 'coordinates' => $this->p($x, $y)]];
    }

    private function polygon(string $kind, float $x, float $y, float $size = .2): array
    {
        return ['kind' => $kind, 'id' => 'way/900', 'tags' => [], 'geometry' => ['type' => 'Polygon', 'coordinates' => [[$this->p($x - $size, $y - $size), $this->p($x + $size, $y - $size), $this->p($x + $size, $y + $size), $this->p($x - $size, $y + $size), $this->p($x - $size, $y - $size)]]]];
    }

    private function snapshot(array $ways, array $extras = []): WalkingRoutingSnapshot
    {
        $features = [...array_map($this->line(...), $ways), ...$extras];

        return new class($ways, $features) extends WalkingRoutingSnapshot
        {
            public array $loadedCoordinates = [];

            public ?array $service = null;

            public mixed $featureFilter = null;

            public array $featureRequests = [];

            public function __construct(public array $source, public array $rows) {}

            public function manifest(): array
            {
                return ['bbox' => [92.8, 55.8, 93.2, 56.2], 'boundary_margin_m' => 1000, 'guard_sources' => ['service_geometry' => $this->service ?? ['type' => 'Polygon', 'coordinates' => [[[92.8, 55.8], [93.2, 55.8], [93.2, 56.2], [92.8, 56.2], [92.8, 55.8]]]]]];
            }

            public function ways(array $ids): array
            {
                return array_values(array_filter($this->source, fn ($w) => in_array($w['id'], $ids, true)));
            }

            public function features(array $coordinates, array $start, array $target): array
            {
                $this->loadedCoordinates = $coordinates;
                $this->featureRequests[] = ['start' => $start, 'target' => $target];

                return $this->featureFilter === null ? $this->rows : ($this->featureFilter)($this->rows, $start, $target);
            }
        };
    }

    private function body(array $coordinates, ?array $ranges = null): array
    {
        $points = array_map(G::utm(...), $coordinates);
        $distance = 0;
        for ($i = 1; $i < count($points); $i++) {
            $distance += G::distance($points[$i - 1], $points[$i]);
        }

        return ['type' => 'FeatureCollection', 'features' => [['type' => 'Feature', 'geometry' => ['type' => 'LineString', 'coordinates' => $coordinates], 'properties' => ['summary' => ['distance' => $distance, 'duration' => max(1, $distance)], 'extras' => ['osmId' => ['values' => $ranges ?? [[0, count($coordinates) - 1, 10]]]]]]]];
    }

    private function review(array $ways, array $extras = [], ?array $body = null, ?array $start = null, ?array $target = null): array
    {
        return (new WalkingGeometryGuard)->review($this->snapshot($ways, $extras), $body ?? $this->body([$ways[0]['coordinates'][0], $ways[array_key_last($ways)]['coordinates'][array_key_last($ways[array_key_last($ways)]['coordinates'])]]), $start ?? $this->selected(0), $target ?? $this->selected(10));
    }

    private function simple(array $tags = []): array
    {
        return $this->way(10, [1, 2], [[0, 0], [10, 0]], $tags);
    }

    public function test_accepted_route_displays_original_bend_and_requests_its_cells(): void
    {
        $way = $this->way(10, [1, 2, 3], [[0, 0], [5, .8], [10, 0]]);
        $snapshot = $this->snapshot([$way]);
        $r = (new WalkingGeometryGuard)->review($snapshot, $this->body([$this->p(0), $this->p(10)]), $this->selected(0), $this->selected(10));
        $this->assertSame('AVAILABLE', $r['status']);
        $this->assertSame($way['coordinates'], $r['geometry']['coordinates']);
        $this->assertContains($this->p(5, .8), $snapshot->loadedCoordinates);
        $this->assertGreaterThan(10, $r['distance_m']);
        $this->assertGreaterThan(0, $r['duration_s']);
    }

    public function test_source_way_and_skipped_node_access_are_checked(): void
    {
        foreach ([['access' => 'private'], ['foot' => 'no'], ['foot:conditional' => 'yes @ (Mo-Fr)'], ['indoor' => 'yes'], ['oneway:foot' => 'yes'], ['conveying' => 'forward']] as $tags) {
            $this->assertSame('UNKNOWN', $this->review([$this->simple($tags)])['status']);
        }
        $way = $this->way(10, [1, 2, 3], [[0, 0], [5, 0], [10, 0]]);
        $r = $this->review([$way], [$this->node(2, 5, 0, ['barrier' => 'gate'])]);
        $this->assertSame('UNKNOWN', $r['status']);
        $this->assertContains('GATE_ACCESS_UNKNOWN', $r['checks']);
    }

    public function test_foot_permission_precedence_and_major_road_policy_are_explicit(): void
    {
        $guard = new WalkingGeometryGuard;
        $this->assertNull($guard->access(['highway' => 'service', 'access' => 'private', 'foot' => 'yes']));
        $this->assertNotNull($guard->access(['highway' => 'primary', 'foot' => 'yes']));
        $this->assertNull($guard->access(['highway' => 'primary', 'foot' => 'yes', 'sidewalk' => 'both']));
        $this->assertNotNull($guard->access(['highway' => 'motorway', 'foot' => 'yes', 'sidewalk' => 'both']));
    }

    public function test_simplified_away_source_bend_hits_small_obstacle(): void
    {
        $way = $this->way(10, [1, 2, 3], [[0, 0], [5, .8], [10, 0]]);
        $r = $this->review([$way], [$this->polygon('water', 5, .8, .1)]);
        $this->assertSame('UNKNOWN', $r['status']);
        $this->assertContains('ROUTE_WATER', $r['checks']);
    }

    public function test_building_intersection_is_not_cleared_by_bridge_or_tunnel_tag(): void
    {
        foreach ([['bridge' => 'yes'], ['tunnel' => 'yes'], ['tunnel' => 'building_passage']] as $tags) {
            $r = $this->review([$this->simple($tags)], [$this->polygon('building', 5, 0)]);
            $this->assertSame('UNKNOWN', $r['status']);
            $this->assertContains('ROUTE_BUILDING', $r['checks']);
        }
        $this->assertSame('AVAILABLE', $this->review([$this->simple(['bridge' => 'yes'])], [$this->polygon('water', 5, 0)])['status']);
    }

    public function test_selected_point_in_building_or_water_requires_refinement_before_router(): void
    {
        foreach (['water', 'building'] as $kind) {
            $r = (new WalkingGeometryGuard)->validatePoint($this->snapshot([$this->simple()], [$this->polygon($kind, 0, 0)]), $this->selected(0));
            $this->assertSame('NEEDS_REFINEMENT', $r['status']);
        }
    }

    public function test_connector_cannot_cross_water_building_barrier_or_another_road(): void
    {
        foreach (['water', 'building'] as $kind) {
            $r = $this->review([$this->simple()], [$this->polygon($kind, 0, 2)], start: $this->selected(0, 4));
            $this->assertSame('NEEDS_REFINEMENT', $r['status']);
        }
        $barrier = $this->line($this->way(90, [90, 91], [[-2, 2], [2, 2]], ['barrier' => 'fence']));
        unset($barrier['tags']['highway']);
        $this->assertSame('NEEDS_REFINEMENT', $this->review([$this->simple()], [$barrier], start: $this->selected(0, 4))['status']);
        $road = $this->line($this->way(90, [90, 91], [[-2, 2], [2, 2]], ['highway' => 'residential']));
        $r = $this->review([$this->simple()], [$road], start: $this->selected(0, 4));
        $this->assertSame('NEEDS_REFINEMENT', $r['status']);
        $this->assertContains('CONNECTOR_ROAD_SIDE_UNKNOWN', $r['checks']);
    }

    public function test_shared_gate_point_requires_original_identity_and_explicit_access(): void
    {
        $way = $this->way(10, [1, 2, 3], [[0, 0], [5, 0], [10, 0]]);
        foreach ([2, 90] as $shared) {
            $f = $this->line($this->way(90, [91, $shared, 92], [[5, -2], [5, 0], [5, 2]], ['barrier' => 'fence']));
            unset($f['tags']['highway']);
            $r = $this->review([$way], [$f, $this->node(2, 5, 0, ['barrier' => 'gate', 'foot' => 'yes'])]);
            $this->assertSame($shared === 2 ? 'AVAILABLE' : 'UNKNOWN', $r['status']);
        }
        $f = $this->line($this->way(90, [91, 2, 92], [[5, -2], [5, 0], [5, 2]], ['barrier' => 'fence']));
        unset($f['tags']['highway']);
        $this->assertSame('UNKNOWN', $this->review([$way], [$f, $this->node(2, 5, 0, ['barrier' => 'gate'])])['status']);
    }

    public function test_collinear_barrier_overlap_and_dual_hazard_are_not_cleared_by_gate(): void
    {
        $way = $this->way(10, [1, 2, 3], [[0, 0], [5, 0], [10, 0]]);
        $overlap = $this->line($this->way(90, [1, 2], [[0, 0], [5, 0]], ['barrier' => 'fence']));
        unset($overlap['tags']['highway']);
        $this->assertSame('UNKNOWN', $this->review([$way], [$overlap, $this->node(2, 5, 0, ['barrier' => 'gate', 'foot' => 'yes'])])['status']);
        $dual = $this->line($this->way(90, [91, 2, 92], [[5, -2], [5, 0], [5, 2]], ['barrier' => 'fence', 'railway' => 'rail']));
        unset($dual['tags']['highway']);
        $r = $this->review([$way], [$dual, $this->node(2, 5, 0, ['barrier' => 'gate', 'foot' => 'yes'])]);
        $this->assertContains('RAILWAY_LEVEL_OR_CROSSING_UNKNOWN', $r['checks']);
        $this->assertNotContains('BARRIER_REVIEW', $r['checks']);
    }

    public function test_rail_crossing_and_separation_require_selected_edge_evidence(): void
    {
        $way = $this->way(10, [1, 2, 3], [[0, 0], [5, 0], [10, 0]]);
        $rail = $this->line($this->way(90, [91, 2, 92], [[5, -2], [5, 0], [5, 2]], ['railway' => 'rail']));
        unset($rail['tags']['highway']);
        $this->assertSame('AVAILABLE', $this->review([$way], [$rail, $this->node(2, 5, 0, ['railway' => 'level_crossing', 'foot' => 'yes'])])['status']);
        $this->assertSame('UNKNOWN', $this->review([$way], [$rail, $this->node(2, 5, 0, ['railway' => 'level_crossing'])])['status']);
        $rail = $this->line($this->way(90, [91, 92], [[5, -2], [5, 2]], ['railway' => 'rail', 'layer' => '0']));
        unset($rail['tags']['highway']);
        $this->assertSame('UNKNOWN', $this->review([$this->simple(['bridge' => 'yes'])], [$rail])['status']);
        $this->assertSame('AVAILABLE', $this->review([$this->simple(['bridge' => 'yes', 'layer' => '1'])], [$rail])['status']);
    }

    public function test_unrelated_nearby_private_way_does_not_contaminate_selected_source_access(): void
    {
        $near = $this->line($this->way(90, [90, 91], [[0, 5], [10, 5]], ['access' => 'private']));
        $this->assertSame('AVAILABLE', $this->review([$this->simple()], [$near])['status']);
    }

    public function test_endpoint_ambiguity_is_preserved_for_parallel_edges_and_distinct_junctions(): void
    {
        $parallel = $this->line($this->way(90, [90, 91], [[0, .8], [10, .8]]));
        $r = (new WalkingGeometryGuard)->validatePoint($this->snapshot([$this->simple()], [$parallel]), $this->selected(0));
        $this->assertSame('CHOOSE', $r['status']);
        $this->assertSame('NEEDS_REFINEMENT', $this->review([$this->simple()], [$parallel])['status']);
    }

    public function test_shared_source_junction_is_one_choice_but_engine_other_edge_still_fails(): void
    {
        $a = $this->simple();
        $b = $this->line($this->way(90, [1, 90], [[0, 0], [0, 10]]));
        $r = (new WalkingGeometryGuard)->validatePoint($this->snapshot([$a], [$b]), $this->selected(0));
        $this->assertSame('SELECTED', $r['status']);
        $this->assertSame($this->selected(0), $r['point']);
        $far = $this->line($this->way(90, [90, 91], [[0, 5], [10, 5]]));
        $r = $this->review([$a], [$far], start: $this->selected(0, 4));
        $this->assertSame('UNKNOWN', $r['status']);
        $this->assertContains('ENGINE_ENDPOINT_DIFFERS_FROM_SOURCE_CANDIDATE', $r['checks']);
    }

    public function test_snap_radius_and_original_selected_points_are_checked(): void
    {
        $r = $this->review([$this->simple()], start: $this->selected(0, 21));
        $this->assertSame('NEEDS_REFINEMENT', $r['status']);
        $this->assertNull($r['distance_m']);
    }

    public function test_invalid_attribution_and_nonpositive_measures_fail_closed_even_for_short_routes(): void
    {
        $way = $this->way(10, [1, 2], [[0, 0], [2, 0]]);
        foreach ([[[0, 1, 10], [0, 1, 20]], [], [[0, 1, 10.0]], [[0, 2, 10]]] as $ranges) {
            $r = $this->review([$way], body: $this->body($way['coordinates'], $ranges), target: $this->selected(2));
            $this->assertSame('UNKNOWN', $r['status']);
            $this->assertNull($r['distance_m']);
        }
        foreach (['distance', 'duration'] as $measure) {
            $body = $this->body($way['coordinates']);
            $body['features'][0]['properties']['summary'][$measure] = 0;
            $this->assertSame('UNKNOWN', $this->review([$way], body: $body, target: $this->selected(2))['status']);
        }
        $body = $this->body([$this->p(0), $this->p(0)]);
        $body['features'][0]['properties']['summary'] = ['distance' => 1, 'duration' => 1];
        $this->assertSame('UNKNOWN', $this->review([$way], body: $body, target: $this->selected(2))['status']);
    }

    public function test_scope_checks_selected_points_and_complete_source_curve(): void
    {
        $snapshot = $this->snapshot([$this->simple()]);
        $guard = new WalkingGeometryGuard;
        $this->assertTrue($guard->scope($snapshot, $this->selected(0), $this->selected(10)));
        $this->assertFalse($guard->scope($snapshot, ['lon' => 92.8001, 'lat' => 56]));
        $r = $guard->review($snapshot, $this->body([$this->p(0), [93.3, 56]]), $this->selected(0), ['lon' => 93.3, 'lat' => 56]);
        $this->assertSame('OUTSIDE_PILOT', $r['status']);
        $snapshot = new class extends WalkingRoutingSnapshot
        {
            public function manifest(): array
            {
                return ['bbox' => [92.8, 55.8, 93.2, 56.2], 'boundary_margin_m' => 1000, 'guard_sources' => ['service_geometry' => ['type' => 'Polygon', 'coordinates' => [[[92.9, 55.9], [93.1, 55.9], [93.1, 56.1], [92.9, 56.1], [92.9, 55.9]], [[92.99999, 55.99999], [93.00001, 55.99999], [93.00001, 56.00001], [92.99999, 56.00001], [92.99999, 55.99999]]]]]];
            }
        };
        $this->assertFalse($guard->scope($snapshot, $this->selected(0)));
    }

    public function test_competing_nearby_junction_anchors_do_not_merge_transitively(): void
    {
        $ways = [$this->way(10, [1, 2], [[0, 0], [1.5, 0]]),
            $this->way(20, [1, 3], [[0, 0], [0, 10]]), $this->way(30, [2, 4], [[1.5, 0], [1.5, 10]])];
        $r = (new WalkingGeometryGuard)->validatePoint($this->snapshot($ways), $this->selected(.75));
        $this->assertSame('CHOOSE', $r['status']);
    }

    public function test_short_forbidden_source_edge_is_never_absorbed_by_distance_tolerance(): void
    {
        $ways = [$this->way(10, [1, 2], [[0, 0], [4.8, 0]]),
            $this->way(20, [2, 3], [[4.8, 0], [5.2, 0]], ['foot' => 'no']), $this->way(30, [3, 4], [[5.2, 0], [10, 0]])];
        $body = $this->body([$this->p(0), $this->p(4.8), $this->p(5.2), $this->p(10)], [[0, 1, 10], [1, 2, 20], [2, 3, 30]]);
        $r = $this->review($ways, body: $body);
        $this->assertSame('UNKNOWN', $r['status']);
        $this->assertContains('ACCESS_DENIED_OR_UNKNOWN', $r['checks']);
    }

    public function test_failed_middle_source_match_keeps_independent_unsafe_endpoint_evidence(): void
    {
        $body = $this->body([$this->p(0), $this->p(10), $this->p(20)], [[0, 1, 10], [1, 2, 999]]);
        $r = $this->review([$this->simple()], [$this->polygon('water', 0, 2)], $body, $this->selected(0, 4), $this->selected(20));
        $this->assertSame('NEEDS_REFINEMENT', $r['status']);
        $this->assertContains('CONNECTOR_WATER', $r['checks']);
        $this->assertNull($r['distance_m']);
    }

    public function test_source_segment_crossing_coverage_hole_is_outside_even_with_both_endpoints_covered(): void
    {
        $snapshot = $this->snapshot([$this->simple()]);
        $outer = $snapshot->manifest()['guard_sources']['service_geometry']['coordinates'][0];
        $hole = $this->polygon('water', 5, 0, 1)['geometry']['coordinates'][0];
        $snapshot->service = ['type' => 'Polygon', 'coordinates' => [$outer, $hole]];
        $guard = new WalkingGeometryGuard;
        $this->assertTrue($guard->scope($snapshot, $this->selected(0), $this->selected(10)));
        $r = $guard->review($snapshot, $this->body([$this->p(0), $this->p(10)]), $this->selected(0), $this->selected(10));
        $this->assertSame('OUTSIDE_PILOT', $r['status']);
    }

    public function test_large_retained_water_polygon_is_indexed_only_in_requested_cells(): void
    {
        $water = $this->polygon('water', 0, 0, 10000);
        $water['geometry']['coordinates'][] = $this->polygon('water', 0, 0, 100)['geometry']['coordinates'][0];
        $r = $this->review([$this->simple()], [$water]);
        $this->assertSame('AVAILABLE', $r['status']);
    }

    public function test_scope_source_failure_is_not_misreported_as_proven_outside_coverage(): void
    {
        $snapshot = new class extends WalkingRoutingSnapshot
        {
            public function manifest(): array
            {
                throw new \RuntimeException('synthetic source missing');
            }
        };
        $this->expectException(RoutingDataException::class);
        (new WalkingGeometryGuard)->scope($snapshot, $this->selected(0));
    }

    private function junction(): array
    {
        return [$this->way(10, [1, 2], [[0, 0], [30, 0]]),
            $this->way(20, [1, 3], [[0, 0], [-30, 0]]), $this->way(30, [1, 4], [[0, 0], [0, 30]])];
    }

    public function test_junction_choices_are_real_source_projections_that_explicitly_revalidate(): void
    {
        $snapshot = $this->snapshot($this->junction());
        $guard = new WalkingGeometryGuard;
        $original = $this->selected(1.5, .95);
        $r = $guard->validatePoint($snapshot, $original);
        $this->assertSame('CHOOSE', $r['status']);
        $this->assertNull($r['point']);
        $this->assertNotEmpty($r['candidates']);
        $this->assertLessThanOrEqual(6, count($r['candidates']));
        foreach ($r['candidates'] as $candidate) {
            $this->assertLessThanOrEqual(20, $candidate['distance_m']);
            $this->assertSame('SELECTED', $guard->validatePoint($snapshot, $candidate['point'])['status']);
            $xy = G::utm(array_values($candidate['point']));
            $this->assertTrue(G::project($xy, G::utm($this->p(0)), G::utm($this->p(30)))[0] < .001
                || G::project($xy, G::utm($this->p(0)), G::utm($this->p(0, 30)))[0] < .001);
        }
        $this->assertSame($this->selected(1.5, .95), $original);
        $first = $r['candidates'][0]['point'];
        $body = $this->body([array_values($first), $this->p(20)]);
        $review = $guard->review($snapshot, $body, $first, $this->selected(20));
        $this->assertSame('AVAILABLE', $review['status']);
    }

    public function test_tight_parallel_and_coincident_source_edges_never_gain_automatic_choices(): void
    {
        foreach ([0, .8] as $gap) {
            $ways = [$this->simple(), $this->way(20, [3, 4], [[0, $gap], [10, $gap]])];
            $r = (new WalkingGeometryGuard)->validatePoint($this->snapshot($ways), $this->selected(5, .4));
            $this->assertSame('CHOOSE', $r['status']);
            $this->assertNull($r['point']);
            $this->assertSame([], $r['candidates']);
        }
    }

    public function test_suggestions_do_not_cross_water_building_barrier_or_railway(): void
    {
        $ways = $this->junction();
        $guard = new WalkingGeometryGuard;
        foreach (['water', 'building', 'barrier', 'railway'] as $hazard) {
            if (in_array($hazard, ['water', 'building'], true)) {
                $extras = [$this->polygon($hazard, 1.5, .475, .15)];
            } else {
                $edge = $this->line($this->way(90, [90, 91], [[-10, .475], [10, .475]], [$hazard => $hazard === 'barrier' ? 'fence' : 'rail']));
                unset($edge['tags']['highway']);
                $extras = [$edge];
            }
            $snapshot = $this->snapshot($ways, $extras);
            $r = $guard->validatePoint($snapshot, $this->selected(1.5, .95));
            $this->assertSame('CHOOSE', $r['status']);
            foreach ($r['candidates'] as $candidate) {
                // The closest horizontal-edge projection lies across the hazard and must never be suggested.
                $this->assertGreaterThan(.4, abs(($candidate['point']['lat'] - 56) * 111300), $hazard);
                $this->assertSame('SELECTED', $guard->validatePoint($snapshot, $candidate['point'])['status']);
            }
        }
    }

    public function test_denied_conditional_or_blocked_source_edges_are_not_suggested(): void
    {
        foreach ([['foot' => 'no'], ['access' => 'private'], ['foot:conditional' => 'yes @ (Mo-Fr)']] as $tags) {
            $ways = $this->junction();
            $ways[0]['tags'] = $tags + ['highway' => 'footway'];
            $r = (new WalkingGeometryGuard)->validatePoint($this->snapshot($ways), $this->selected(1.5, .95));
            foreach ($r['candidates'] as $candidate) {
                $this->assertLessThan(.25, abs(($candidate['point']['lon'] - 93) * 62376));
            }
            $this->assertNull($r['distance_m']);
        }
        $r = (new WalkingGeometryGuard)->validatePoint($this->snapshot($this->junction(), [$this->node(2, 30, 0, ['barrier' => 'gate'])]), $this->selected(1.5, .95));
        foreach ($r['candidates'] as $candidate) {
            $this->assertLessThan(.25, abs(($candidate['point']['lon'] - 93) * 62376));
        }
    }

    public function test_new_candidate_neighbourhood_cannot_hide_a_new_parallel_street(): void
    {
        $ways = [$this->way(10, [1, 2], [[19.9, -30], [19.9, 30]]),
            $this->way(20, [3, 4], [[-19.9, -30], [-19.9, 30]]), $this->way(30, [5, 6], [[20.7, -30], [20.7, 30]])];
        $snapshot = $this->snapshot($ways);
        $snapshot->featureFilter = function ($rows, $start, $target) {
            return array_values(array_filter($rows, function ($row) use ($start, $target) {
                [$a,$b] = array_map(G::utm(...), $row['geometry']['coordinates']);

                return min(G::project(G::utm(array_values($start)), $a, $b)[0], G::project(G::utm(array_values($target)), $a, $b)[0]) <= 20.5;
            }));
        };
        $r = (new WalkingGeometryGuard)->validatePoint($snapshot, $this->selected(0));
        $this->assertSame('CHOOSE', $r['status']);
        $this->assertNotEmpty($r['candidates']);
        foreach ($r['candidates'] as $candidate) {
            $this->assertLessThan(93, $candidate['point']['lon']);
        }
        $this->assertGreaterThan(1, count($snapshot->featureRequests));
        $this->assertTrue((bool) array_filter($snapshot->featureRequests, fn ($request) => $request['target']['lon'] > 93));
    }

    public function test_a_newly_selected_different_source_identity_is_not_relabelled_as_a_candidate(): void
    {
        $ways = [$this->way(10, [1, 2], [[19.9, -30], [19.9, 30]]), $this->way(20, [3, 4], [[-19.9, -30], [-19.9, 30]])];
        $snapshot = $this->snapshot($ways);
        $replacement = $this->line($this->way(90, [90, 91], [[19.9, -30], [19.9, 30]]));
        $snapshot->featureFilter = function ($rows, $start, $target) use ($replacement) {
            return $target['lon'] > 93 ? [$rows[1], $replacement] : $rows;
        };
        $r = (new WalkingGeometryGuard)->validatePoint($snapshot, $this->selected(0));
        $this->assertSame('CHOOSE', $r['status']);
        $this->assertNotEmpty($r['candidates']);
        foreach ($r['candidates'] as $candidate) {
            $this->assertLessThan(93, $candidate['point']['lon']);
        }
    }

    public function test_suggestion_list_is_bounded_and_deduplicated_without_auto_selection(): void
    {
        $ways = [];
        for ($i = 0; $i < 8; $i++) {
            $angle = $i * M_PI / 4;
            $x = 10 * cos($angle);
            $y = 10 * sin($angle);
            $dx = -sin($angle) * 5;
            $dy = cos($angle) * 5;
            $ways[] = $this->way(10 + $i, [2 * $i + 1, 2 * $i + 2], [[$x - $dx, $y - $dy], [$x + $dx, $y + $dy]]);
        }
        $snapshot = $this->snapshot($ways);
        $guard = new WalkingGeometryGuard;
        $r = $guard->validatePoint($snapshot, $this->selected(0));
        $this->assertSame('CHOOSE', $r['status']);
        $this->assertNull($r['point']);
        $this->assertCount(6, $r['candidates']);
        $this->assertLessThanOrEqual(13, count($snapshot->featureRequests));
        foreach ($r['candidates'] as $i => $candidate) {
            foreach (array_slice($r['candidates'], $i + 1) as $other) {
                $this->assertGreaterThan(.25, G::distance(G::utm(array_values($candidate['point'])), G::utm(array_values($other['point']))));
            }
            $this->assertSame('SELECTED', $guard->validatePoint($snapshot, $candidate['point'])['status']);
        }
    }

    public function test_candidate_checks_share_fail_closed_budget_and_do_not_return_partial_choices(): void
    {
        $snapshot = $this->snapshot($this->junction());
        $calls = 0;
        $snapshot->featureFilter = function ($rows) use (&$calls) {
            if (++$calls === 3) {
                throw new RoutingDataException('synthetic candidate read budget');
            }

            return $rows;
        };
        $r = (new WalkingGeometryGuard)->validatePoint($snapshot, $this->selected(1.5, .95));
        $this->assertSame('UNKNOWN', $r['status']);
        $this->assertSame([], $r['candidates']);
        $this->assertNull($r['point']);
        $this->assertNull($r['distance_m']);
    }

    public function test_limited_reader_failure_is_unknown_and_metrics_stay_null(): void
    {
        $snapshot = new class extends WalkingRoutingSnapshot
        {
            public function manifest(): array
            {
                throw new \RuntimeException('synthetic fixture unavailable');
            }
        };
        $r = (new WalkingGeometryGuard)->review($snapshot, [], $this->selected(0), $this->selected(10));
        $this->assertSame('UNKNOWN', $r['status']);
        $this->assertNull($r['geometry']);
        $this->assertNull($r['distance_m']);
        $this->assertNull($r['duration_s']);
    }
}
