<?php

namespace Tests\Unit;

use App\Services\Routing\WalkingGeometry as G;
use PHPUnit\Framework\TestCase;

class WalkingGeometryTest extends TestCase
{
    public function test_utm46n_uses_metres_and_longitude_latitude_order(): void
    {
        $p = G::utm([93, 56]);
        $this->assertEqualsWithDelta(500000, $p[0], .0001);
        $this->assertEqualsWithDelta(6206079.587, $p[1], .02);
        $this->assertEqualsWithDelta(62.376, G::distance($p, G::utm([93.001, 56])), .03);
        $this->assertFalse(G::coordinate([56, 93]));
    }

    public function test_point_intersections_and_collinear_overlap_are_distinct(): void
    {
        $this->assertTrue(G::intersects([0, 0], [10, 0], [5, -1], [5, 1]));
        $this->assertFalse(G::overlap([0, 0], [10, 0], [5, -1], [5, 1]));
        $this->assertTrue(G::overlap([0, 0], [10, 0], [5, 0], [15, 0]));
        $this->assertFalse(G::intersects([0, 0], [10, 0], [11, 0], [15, 0]));
    }

    public function test_holes_and_polygon_boundary_are_checked(): void
    {
        $p = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]];
        $this->assertTrue(G::inside([2, 2], $p));
        $this->assertFalse(G::inside([5, 5], $p));
        $this->assertTrue(G::touches([-1, 5], [11, 5], $p));
        $this->assertTrue(G::touches([0, 5], [0, 5], $p));
    }
}
