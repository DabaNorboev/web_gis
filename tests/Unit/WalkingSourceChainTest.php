<?php

namespace Tests\Unit;

use App\Services\Routing\RoutingDataException;
use App\Services\Routing\WalkingSourceChain;
use PHPUnit\Framework\TestCase;

class WalkingSourceChainTest extends TestCase
{
    private function p(float $x, float $y = 0): array
    {
        return [93 + $x / 62376, 56 + $y / 111300];
    }

    private function way(int $id, array $nodes, array $points): array
    {
        return ['id' => $id, 'nodes' => $nodes, 'coordinates' => array_map(fn ($p) => $this->p(...$p), $points), 'tags' => ['highway' => 'footway']];
    }

    private function match(array $ways, array $points, array $ids): array
    {
        return (new WalkingSourceChain($ways))->match(array_map(fn ($p) => $this->p(...$p), $points), $ids);
    }

    public function test_simplified_bend_and_intermediate_node_are_retained_in_both_directions(): void
    {
        $way = $this->way(10, [1, 2, 3], [[0, 0], [5, .8], [10, 0]]);
        foreach ([[[0, 0], [10, 0]], [[10, 0], [0, 0]]] as $points) {
            $r = $this->match([$way], $points, [10]);
            $this->assertSame('MATCHED', $r['status']);
            $this->assertCount(2, $r['segments']);
            $this->assertSame(2, $r['segments'][0]['end_node']);
            $this->assertSame($this->p(5, .8), $r['segments'][0]['coordinates'][1]);
        }
    }

    public function test_representation_allowance_never_increases_endpoint_allowance(): void
    {
        $way = $this->way(10, [1, 2], [[0, 0], [10, 0]]);
        $this->assertSame('UNMATCHED', $this->match([$way], [[0, .3], [10, .3]], [10])['status']);
        $bent = $this->way(10, [1, 2, 3], [[0, 0], [5, 1.3], [10, 0]]);
        $this->assertSame('UNMATCHED', $this->match([$bent], [[0, 0], [10, 0]], [10])['status']);
    }

    public function test_same_coordinate_does_not_join_different_original_nodes(): void
    {
        $a = $this->way(10, [1, 2], [[0, 0], [5, 0]]);
        $b = $this->way(20, [3, 4], [[5, 0], [10, 0]]);
        $r = $this->match([$a, $b], [[0, 0], [5, 0], [10, 0]], [10, 20]);
        $this->assertSame('UNMATCHED', $r['status']);
        $this->assertContains('SOURCE_NODE_CONTINUITY_MISMATCH', $r['reasons']);
        $this->assertCount(2, $r['segments']);
        $b['nodes'][0] = 2;
        $this->assertSame('MATCHED', $this->match([$a, $b], [[0, 0], [5, 0], [10, 0]], [10, 20])['status']);
    }

    public function test_global_continuity_resolves_a_local_repeated_edge(): void
    {
        $a = $this->way(10, [1, 2, 3, 4], [[0, 0], [10, 0], [0, 0], [10, 0]]);
        $this->assertSame('AMBIGUOUS', $this->match([$a], [[2, 0], [8, 0]], [10])['status']);
        $b = $this->way(20, [4, 5], [[10, 0], [20, 0]]);
        $r = $this->match([$a, $b], [[2, 0], [10, 0], [20, 0]], [10, 20]);
        $this->assertSame('MATCHED', $r['status']);
        $this->assertSame(2, $r['segments'][0]['edge_index']);
    }

    public function test_closed_way_wraps_across_original_endpoint(): void
    {
        $a = $this->way(10, [1, 2, 3, 4, 1], [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]);
        $r = $this->match([$a], [[0, 1], [1, 0]], [10]);
        $this->assertSame('MATCHED', $r['status']);
        $this->assertSame([3, 0], array_column($r['segments'], 'edge_index'));
    }

    public function test_partial_edges_keep_fractions_and_only_traversed_nodes(): void
    {
        $r = $this->match([$this->way(10, [1, 2, 3], [[0, 0], [5, 0], [10, 0]])], [[2, 0], [4, 0], [8, 0]], [10, 10]);
        $this->assertSame('MATCHED', $r['status']);
        $this->assertNull($r['segments'][0]['start_node']);
        $this->assertNull($r['segments'][0]['end_node']);
        $this->assertSame(2, $r['segments'][1]['end_node']);
    }

    public function test_declared_way_is_used_without_nearby_road_contamination(): void
    {
        $a = $this->way(10, [1, 2], [[0, 0], [10, 0]]);
        $b = $this->way(20, [3, 4], [[0, .2], [10, .2]]);
        $r = $this->match([$a, $b], [[0, 0], [10, 0]], [20]);
        $this->assertSame('MATCHED', $r['status']);
        $this->assertSame(20, $r['segments'][0]['way']);
        $this->assertSame('UNMATCHED', $this->match([$a], [[0, 0], [10, 0]], [999])['status']);
    }

    public function test_conflicting_geometry_for_one_source_node_fails_closed(): void
    {
        $this->expectException(RoutingDataException::class);
        new WalkingSourceChain([$this->way(10, [1, 2], [[0, 0], [10, 0]]), $this->way(20, [2, 3], [[10, .2], [20, 0]])]);
    }

    public function test_large_repeated_source_position_search_is_bounded(): void
    {
        $points = [];
        $nodes = [];
        for ($i = 0; $i < 80; $i++) {
            $points[] = [$i % 2 ? 10 : 0, 0];
            $nodes[] = $i + 1;
        }
        $this->expectException(RoutingDataException::class);
        $this->match([$this->way(10, $nodes, $points)], [[2, 0], [8, 0]], [10]);
    }
}
