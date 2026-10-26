<?php

namespace App\Services\Routing;

/** Unique global interpretation of declared ORS way IDs on retained OSM edges. */
final class WalkingSourceChain
{
    private const EPS = 1e-7;

    private array $ways = [];

    private int $work = 0;

    private int $candidatePieces = 0;

    private float $deadline;

    public function __construct(array $ways)
    {
        $this->deadline = microtime(true) + 2;
        $nodes = [];
        $edges = 0;
        foreach ($ways as $way) {
            $id = $way['id'] ?? null;
            if (! is_int($id) || $id < 1 || isset($this->ways[$id]) || ! is_array($way['nodes'] ?? null)
                || ! is_array($way['coordinates'] ?? null) || count($way['nodes']) < 2 || count($way['nodes']) !== count($way['coordinates'])) {
                throw new RoutingDataException('Invalid walking source way');
            }
            $edges += count($way['nodes']) - 1;
            if ($edges > 40000) {
                throw new RoutingDataException('Walking source edge budget');
            }
            WalkingGeometry::memoryBudget();
            $way['points'] = array_map(WalkingGeometry::utm(...), $way['coordinates']);
            foreach ($way['nodes'] as $i => $node) {
                if (! is_int($node) || $node < 1 || (isset($nodes[$node]) && WalkingGeometry::distance($nodes[$node], $way['points'][$i]) > 1e-7)) {
                    throw new RoutingDataException('Conflicting walking source node identity');
                }
                $nodes[$node] = $way['points'][$i];
            }
            $way['tags'] ??= [];
            $this->ways[$id] = $way;
        }
    }

    private function tick(int $amount = 1): void
    {
        $this->work += $amount;
        if ($this->work % 256 === 0) {
            WalkingGeometry::memoryBudget();
        }
        if ($this->work > 1000000 || microtime(true) > $this->deadline) {
            throw new RoutingDataException('Walking chain budget exceeded');
        }
    }

    private function positions(array $raw, array $way): array
    {
        $positions = [];
        for ($i = 0; $i < count($way['points']) - 1; $i++) {
            $this->tick();
            $a = $way['points'][$i];
            $b = $way['points'][$i + 1];
            [$error,$projected,$fraction] = WalkingGeometry::project($raw, $a, $b);
            if ($error > .25 + 1e-9) {
                continue;
            }
            $close = [];
            foreach ([$i => $a, $i + 1 => $b] as $index => $point) {
                $gap = WalkingGeometry::distance($raw, $point);
                if ($gap <= .25 + 1e-9) {
                    $close[] = [$index, $point, $gap];
                }
            }
            if ($close) {
                foreach ($close as [$index,$point,$gap]) {
                    $positions[(string) $index] = ['position' => (float) $index, 'point' => $point, 'node' => $way['nodes'][$index], 'canonicalized' => $gap > 1e-9, 'endpoint_error_m' => $gap];
                }
            } else {
                $station = $i + $fraction;
                $node = null;
                if ($fraction <= self::EPS) {
                    $station = (float) $i;
                    $node = $way['nodes'][$i];
                } elseif (1 - $fraction <= self::EPS) {
                    $station = (float) ($i + 1);
                    $node = $way['nodes'][$i + 1];
                }
                $positions[sprintf('%.12f', $station)] = ['position' => $station, 'point' => $projected, 'node' => $node, 'canonicalized' => false, 'endpoint_error_m' => $error];
            }
        }
        if (count($positions) > 32) {
            throw new RoutingDataException('Walking source position budget');
        }

        return array_values($positions);
    }

    private function pieces(array $way, array $start, array $end, int $raw, array $a, array $b): ?array
    {
        $s = $start['position'];
        $e = $end['position'];
        if (abs($s - $e) <= self::EPS) {
            return null;
        }
        $forward = $e > $s;
        $lo = min($s, $e);
        $hi = max($s, $e);
        $pieces = [];
        $maximum = 0;
        for ($i = (int) floor($lo); $i < min(ceil($hi), count($way['nodes']) - 1); $i++) {
            $this->tick();
            $t0 = max(0, $lo - $i);
            $t1 = min(1, $hi - $i);
            if ($t1 - $t0 <= self::EPS) {
                continue;
            }
            if (! $forward) {
                [$t0,$t1] = [$t1, $t0];
            }
            $p = $way['points'][$i];
            $q = $way['points'][$i + 1];
            $left = WalkingGeometry::point($p, $q, $t0);
            $right = WalkingGeometry::point($p, $q, $t1);
            $maximum = max($maximum, WalkingGeometry::project($left, $a, $b)[0], WalkingGeometry::project($right, $a, $b)[0]);
            if ($maximum > 1.25 + 1e-9) {
                return null;
            }
            $node = fn ($t) => $t <= self::EPS ? $way['nodes'][$i] : (1 - $t <= self::EPS ? $way['nodes'][$i + 1] : null);
            $pieces[] = ['way' => $way['id'], 'edge_index' => $i, 'u' => $way['nodes'][$i], 'v' => $way['nodes'][$i + 1],
                'a' => $left, 'b' => $right, 't0' => $t0, 't1' => $t1, 'tags' => $way['tags'], 'forward' => $forward,
                'start_node' => $node($t0), 'end_node' => $node($t1), 'raw_segment_index' => $raw,
                // Fractions are defined on the UTM source edge; geographic interpolation retains original endpoints exactly.
                'coordinates' => [WalkingGeometry::point($way['coordinates'][$i], $way['coordinates'][$i + 1], $t0), WalkingGeometry::point($way['coordinates'][$i], $way['coordinates'][$i + 1], $t1)]];
        }
        if (! $pieces) {
            return null;
        }
        if (! $forward) {
            $pieces = array_reverse($pieces);
        }
        foreach ($pieces as &$piece) {
            $piece['max_deviation_m'] = $maximum;
        } unset($piece);

        return ['pieces' => $pieces, 'start' => $start, 'end' => $end, 'way' => $way['id']];
    }

    private function chains(array $way, array $start, array $end, int $index, array $a, array $b): array
    {
        $direct = $this->pieces($way, $start, $end, $index, $a, $b);
        $result = $direct ? [$direct] : [];
        if ($way['nodes'][0] !== $way['nodes'][array_key_last($way['nodes'])] || abs($start['position'] - $end['position']) <= self::EPS) {
            return $result;
        }
        $last = count($way['nodes']) - 1;
        $endpoint = fn ($i) => ['position' => (float) $i, 'point' => $way['points'][$i], 'node' => $way['nodes'][$i], 'canonicalized' => false, 'endpoint_error_m' => 0];
        $s = $start['position'];
        $e = $end['position'];
        $pieces = [];
        foreach ([[$start, $endpoint($s > $e ? $last : 0)], [$endpoint($s > $e ? 0 : $last), $end]] as [$l,$r]) {
            if (abs($l['position'] - $r['position']) <= self::EPS) {
                continue;
            }
            $portion = $this->pieces($way, $l, $r, $index, $a, $b);
            if (! $portion) {
                return $result;
            }
            array_push($pieces, ...$portion['pieces']);
        }
        if ($pieces) {
            $result[] = ['pieces' => $pieces, 'start' => $start, 'end' => $end, 'way' => $way['id']];
        }

        return $result;
    }

    private function continuous(array $left, array $right): bool
    {
        $a = $left['end'];
        $b = $right['start'];

        return $a['node'] !== null && $b['node'] !== null ? $a['node'] === $b['node']
            : $left['way'] === $right['way'] && abs($a['position'] - $b['position']) <= self::EPS;
    }

    public function match(array $coordinates, array $attribution): array
    {
        if (count($coordinates) < 2 || count($coordinates) > 10000 || count($attribution) !== count($coordinates) - 1) {
            throw new RoutingDataException('Invalid walking shape attribution');
        }
        $points = array_map(WalkingGeometry::utm(...), $coordinates);
        $candidates = [];
        $reasons = [];
        for ($i = 0; $i < count($points) - 1; $i++) {
            $id = $attribution[$i];
            $matches = [];
            $a = $points[$i];
            $b = $points[$i + 1];
            if (! is_int($id) || ! isset($this->ways[$id])) {
                $reasons[] = 'DECLARED_OSM_WAY_NOT_IN_SOURCE';
            } elseif (WalkingGeometry::distance($a, $b) < 1e-7) {
                $reasons[] = 'ZERO_LENGTH_SHAPE_SEGMENT';
            } else {
                $way = $this->ways[$id];
                $starts = $this->positions($a, $way);
                $ends = $this->positions($b, $way);
                foreach ($starts as $start) {
                    foreach ($ends as $end) {
                        foreach ($this->chains($way, $start, $end, $i, $a, $b) as $chain) {
                            $key = json_encode(array_map(fn ($p) => [$p['edge_index'], round($p['t0'], 10), round($p['t1'], 10)], $chain['pieces']));
                            if (! isset($matches[$key])) {
                                $this->candidatePieces += count($chain['pieces']);
                                if ($this->candidatePieces > 40000) {
                                    throw new RoutingDataException('Walking retained candidate budget');
                                }
                            }
                            $matches[$key] = $chain;
                            if (count($matches) > 128) {
                                throw new RoutingDataException('Walking chain candidate budget');
                            }
                        }
                    }
                }
                if (! $matches) {
                    $reasons[] = $starts && $ends ? 'SOURCE_CHAIN_REPRESENTATION_MISMATCH' : 'SOURCE_CHAIN_ENDPOINT_MISMATCH';
                }
            }
            $candidates[] = array_values($matches);
        }
        $counts = [];
        $links = [];
        foreach ($candidates as $i => $row) {
            $counts[$i] = [];
            $links[$i] = [];
            foreach ($row as $j => $chain) {
                $previous = [];
                $count = $i ? 0 : 1;
                if ($i) {
                    foreach ($candidates[$i - 1] as $k => $left) {
                        $this->tick();
                        if ($counts[$i - 1][$k] && $this->continuous($left, $chain)) {
                            $previous[] = $k;
                            $count = min(2, $count + $counts[$i - 1][$k]);
                        }
                    }
                }
                $counts[$i][$j] = $count;
                $links[$i][$j] = $previous;
            }
        }
        $last = count($candidates) - 1;
        $total = min(2, array_sum($counts[$last]));
        $selected = [];
        if ($total) {
            $reachable = array_keys(array_filter($counts[$last]));
            for ($i = $last; $i >= 0; $i--) {
                if (count($reachable) === 1) {
                    $selected[$i] = $candidates[$i][$reachable[0]];
                }
                $next = [];
                foreach ($reachable as $j) {
                    foreach ($links[$i][$j] as $k) {
                        $next[$k] = true;
                    }
                } $reachable = array_keys($next);
            }
        } else {
            foreach ($candidates as $i => $row) {
                if (count($row) === 1) {
                    $selected[$i] = $row[0];
                }
            }
            $reasons[] = 'SOURCE_NODE_CONTINUITY_MISMATCH';
        }
        if ($total > 1) {
            $reasons[] = 'AMBIGUOUS_SOURCE_CHAIN';
        }
        ksort($selected);
        $segments = [];
        foreach ($selected as $chain) {
            array_push($segments, ...$chain['pieces']);
            if (count($segments) > 9999) {
                throw new RoutingDataException('Walking output edge budget');
            }
        }

        return ['status' => $total === 1 ? 'MATCHED' : ($total > 1 ? 'AMBIGUOUS' : 'UNMATCHED'), 'reasons' => array_values(array_unique($reasons)), 'segments' => $segments];
    }
}
