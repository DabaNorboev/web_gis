<?php

namespace App\Services\Routing;

/** Source-model guard for the limited ORS walking pilot. No DB or citywide scan. */
class WalkingGeometryGuard
{
    private const ALLOW = ['yes', 'designated', 'permissive'];

    private const CLASSES = ['footway', 'path', 'pedestrian', 'steps', 'living_street', 'residential', 'service', 'unclassified', 'tertiary', 'tertiary_link', 'track'];

    private const GATES = ['gate', 'lift_gate', 'wicket_gate', 'entrance', 'door', 'kissing_gate', 'swing_gate', 'sliding_gate'];

    private int $work = 0;

    private array $activeCells = [];

    private float $deadline;

    private function begin(): void
    {
        $this->work = 0;
        $this->activeCells = [];
        $this->deadline = microtime(true) + 3;
        WalkingGeometry::budget(3);
    }

    private function tick(int $n = 1): void
    {
        $this->work += $n;
        if ($this->work > 1000000 || microtime(true) > $this->deadline) {
            throw new RoutingDataException('Walking geometry budget exceeded');
        }
    }

    /** Selected points and every reconstructed source edge must stay inside this scope. */
    public function scope(WalkingRoutingSnapshot $snapshot, array $start, ?array $target = null): bool
    {
        $this->begin();
        try {
            $m = $snapshot->manifest();
            $area = $this->area($m);

            return $this->covered($this->xy($start), $area) && ($target === null || $this->covered($this->xy($target), $area));
        } catch (\Throwable $exception) {
            throw new RoutingDataException('Walking coverage source unavailable', previous: $exception);
        } finally {
            WalkingGeometry::budget(null);
        }
    }

    private function xy(array $point): array
    {
        return WalkingGeometry::utm([$point['lon'] ?? null, $point['lat'] ?? null]);
    }

    private function area(array $m): array
    {
        [$w,$s,$e,$n] = $m['bbox'];
        $box = array_map(WalkingGeometry::utm(...), [[$w, $s], [$e, $s], [$e, $n], [$w, $n], [$w, $s]]);
        $margin = $m['boundary_margin_m'] ?? 1000;
        if ($margin !== 1000 && $margin !== 1000.0) {
            throw new RoutingDataException('Unsupported walking boundary margin');
        }

        return ['box' => $box, 'polygons' => WalkingGeometry::polygons($m['guard_sources']['service_geometry'] ?? $m['service_geometry'])];
    }

    private function covered(array $point, array $area): bool
    {
        if (! WalkingGeometry::insideRing($point, $area['box'])) {
            return false;
        }
        for ($i = 1; $i < count($area['box']); $i++) {
            if (WalkingGeometry::project($point, $area['box'][$i - 1], $area['box'][$i])[0] < 1000) {
                return false;
            }
        }
        foreach ($area['polygons'] as $polygon) {
            if (WalkingGeometry::inside($point, $polygon)) {
                return true;
            }
        }

        return false;
    }

    private function edgeCovered(array $a, array $b, array $area): bool
    {
        if (! $this->covered($a, $area) || ! $this->covered($b, $area)) {
            return false;
        }
        // Conservative boundary contact rejection also detects concave excursions and holes.
        foreach ($area['polygons'] as $polygon) {
            foreach ($polygon as $ring) {
                for ($i = 1; $i < count($ring); $i++) {
                    $this->tick();
                    if (WalkingGeometry::intersects($a, $b, $ring[$i - 1], $ring[$i])) {
                        return false;
                    }
                }
            }
        }

        return true;
    }

    /** Walking foot overrides access, while unmodelled conditions never grant access. */
    public function access(array $tags, bool $node = false): ?string
    {
        foreach (array_keys($tags) as $key) {
            if (str_contains($key, 'conditional') && (str_starts_with($key, 'foot') || str_starts_with($key, 'access'))) {
                return 'CONDITIONAL_ACCESS_UNKNOWN';
            }
        }
        $value = $tags['foot'] ?? $tags['access'] ?? null;
        if ($value !== null && ! in_array($value, self::ALLOW, true)) {
            return 'ACCESS_DENIED_OR_UNKNOWN';
        }
        if (($tags['locked'] ?? null) === 'yes') {
            return 'LOCKED_GATE';
        }
        if (! in_array($tags['indoor'] ?? null, [null, 'no'], true) || in_array($tags['highway'] ?? null, ['corridor', 'elevator'], true)
            || ! in_array($tags['conveying'] ?? null, [null, 'no'], true)) {
            return 'INDOOR_OR_CONVEYING_UNKNOWN';
        }
        if (! in_array($tags['oneway:foot'] ?? null, [null, 'no'], true)) {
            return 'PEDESTRIAN_DIRECTION_REVIEW';
        }
        if ($node) {
            $barrier = $tags['barrier'] ?? null;
            if (in_array($barrier, [null, 'no', 'kerb', 'bollard'], true)) {
                return null;
            }

            return in_array($barrier, self::GATES, true) ? (in_array($value, self::ALLOW, true) ? null : 'GATE_ACCESS_UNKNOWN') : 'BARRIER_NODE_UNKNOWN';
        }
        $highway = $tags['highway'] ?? null;
        if (in_array($highway, ['construction', 'proposed', 'motorway', 'motorway_link'], true) || ($tags['area'] ?? null) === 'yes') {
            return 'UNSUPPORTED_OR_FORBIDDEN_HIGHWAY';
        }
        if (! in_array($highway, self::CLASSES, true)) {
            $sidewalk = false;
            foreach (['sidewalk', 'sidewalk:left', 'sidewalk:right'] as $key) {
                $sidewalk = $sidewalk || in_array($tags[$key] ?? null, ['yes', 'both', 'left', 'right'], true);
            }
            if (! in_array($value, self::ALLOW, true) || ! $sidewalk) {
                return 'MAJOR_ROAD_PEDESTRIAN_ACCESS_UNKNOWN';
            }
        }

        return null;
    }

    private function cells(array $a, array $b, float $margin = .3): array
    {
        $result = [];
        for ($x = (int) floor((min($a[0], $b[0]) - $margin) / 100); $x <= (int) floor((max($a[0], $b[0]) + $margin) / 100); $x++) {
            for ($y = (int) floor((min($a[1], $b[1]) - $margin) / 100); $y <= (int) floor((max($a[1], $b[1]) + $margin) / 100); $y++) {
                $this->tick();
                $result[] = "$x:$y";
                if (count($result) > 10000) {
                    throw new RoutingDataException('Walking spatial cell budget');
                }
            }
        }

        return $result;
    }

    /** Limit indexing of large retained water polygons to cells required by this request. */
    private function restrictCells(array $coordinates, array $start, array $target): void
    {
        $positions = [$this->xy($start), ...array_map(WalkingGeometry::utm(...), $coordinates), $this->xy($target)];
        for ($i = 1; $i < count($positions); $i++) {
            foreach ($this->cells($positions[$i - 1], $positions[$i]) as $cell) {
                $this->activeCells[$cell] = true;
            }
            if (count($this->activeCells) > 10000) {
                throw new RoutingDataException('Walking local index budget');
            }
        }
        foreach ([$positions[0], $positions[array_key_last($positions)]] as $point) {
            foreach ($this->cells($point, $point, 20.5) as $cell) {
                $this->activeCells[$cell] = true;
            }
        }
    }

    private function indexCells(array $a, array $b): array
    {
        $west = (int) floor((min($a[0], $b[0]) - .3) / 100);
        $east = (int) floor((max($a[0], $b[0]) + .3) / 100);
        $south = (int) floor((min($a[1], $b[1]) - .3) / 100);
        $north = (int) floor((max($a[1], $b[1]) + .3) / 100);
        if (($east - $west + 1) * ($north - $south + 1) <= count($this->activeCells)) {
            return array_values(array_filter($this->cells($a, $b), fn ($cell) => isset($this->activeCells[$cell])));
        }
        $result = [];
        foreach ($this->activeCells as $cell => $_) {
            $this->tick();
            [$x,$y] = array_map('intval', explode(':', $cell));
            if ($x >= $west && $x <= $east && $y >= $south && $y <= $north) {
                $result[] = $cell;
            }
        }

        return $result;
    }

    private function prepare(array $features): array
    {
        $data = ['edges' => [], 'polygons' => [], 'nodes' => [], 'points' => [], 'index' => []];
        $vertices = 0;
        foreach ($features as $f) {
            $this->tick();
            $kind = $f['kind'];
            $g = $f['geometry'];
            $tags = $f['tags'] ?? [];
            if ($kind === 'node') {
                if (! preg_match('/^node\/[1-9][0-9]*$/D', $f['id']) || ($g['type'] ?? null) !== 'Point') {
                    throw new RoutingDataException('Invalid walking source node feature');
                }
                $id = (int) substr((string) $f['id'], 5);
                $p = WalkingGeometry::utm($g['coordinates']);
                $data['nodes'][$id] = ['point' => $p, 'tags' => $tags];

                continue;
            }
            if ($kind === 'line') {
                if (($g['type'] ?? null) !== 'LineString' || count($g['coordinates']) !== count($f['nodes']) || count($f['nodes']) < 2) {
                    throw new RoutingDataException('Invalid walking feature line');
                }
                if (! preg_match('/^way\/[1-9][0-9]*$/D', $f['id'])) {
                    throw new RoutingDataException('Invalid walking source line identity');
                }
                $way = (int) preg_replace('/^way\//', '', (string) $f['id']);
                $points = array_map(WalkingGeometry::utm(...), $g['coordinates']);
                foreach ($points as $i => $p) {
                    $node = $f['nodes'][$i];
                    if (! is_int($node) || $node < 1 || (isset($data['points'][$node]) && WalkingGeometry::distance($p, $data['points'][$node]) > 1e-7)) {
                        throw new RoutingDataException('Inconsistent walking node geometry');
                    }
                    $data['points'][$node] = $p;
                    if (! $i) {
                        continue;
                    }
                    $edge = ['way' => $way, 'u' => $f['nodes'][$i - 1], 'v' => $node, 'a' => $points[$i - 1], 'b' => $p, 'tags' => $tags,
                        'coordinates' => [$g['coordinates'][$i - 1], $g['coordinates'][$i]]];
                    $key = 'e'.count($data['edges']);
                    $data['edges'][$key] = $edge;
                    foreach ($this->indexCells($edge['a'], $p) as $cell) {
                        $data['index'][$cell][$key] = true;
                    }
                }
                $vertices += count($points);
            } elseif (in_array($kind, ['water', 'building'], true)) {
                $polygons = WalkingGeometry::polygons($g);
                foreach ($polygons as $polygon) {
                    $key = 'p'.count($data['polygons']);
                    $data['polygons'][$key] = ['kind' => $kind, 'polygon' => $polygon];
                    $xs = array_column($polygon[0], 0);
                    $ys = array_column($polygon[0], 1);
                    foreach ($this->indexCells([min($xs), min($ys)], [max($xs), max($ys)]) as $cell) {
                        $data['index'][$cell][$key] = true;
                    }
                    foreach ($polygon as $ring) {
                        $vertices += count($ring);
                    }
                }
            } else {
                throw new RoutingDataException('Unsupported walking guard feature');
            }
            if ($vertices > 100000 || count($data['edges']) > 40000) {
                throw new RoutingDataException('Walking guard feature budget');
            }
        }
        foreach ($data['nodes'] as $id => $node) {
            if (isset($data['points'][$id]) && WalkingGeometry::distance($node['point'], $data['points'][$id]) > 1e-7) {
                throw new RoutingDataException('Walking tagged node identity mismatch');
            }
            $data['points'][$id] = $node['point'];
            foreach ($this->indexCells($node['point'], $node['point']) as $cell) {
                $data['index'][$cell]['n'.$id] = true;
            }
        }

        return $data;
    }

    private function query(array $data, array $a, array $b, float $margin = .3): array
    {
        $keys = [];
        foreach ($this->cells($a, $b, $margin) as $cell) {
            foreach ($data['index'][$cell] ?? [] as $key => $_) {
                $keys[$key] = true;
            }
        }

        return array_keys($keys);
    }

    private function conflicts(array $a, array $b, array $data, ?array $piece = null): array
    {
        $issues = [];
        $connector = $piece === null;
        $tags = $piece['tags'] ?? [];
        $roadNodes = $piece ? array_values(array_filter([$piece['start_node'], $piece['end_node']], fn ($n) => $n !== null)) : [];
        $bridge = in_array($tags['bridge'] ?? null, ['yes', 'viaduct', 'boardwalk'], true);
        $tunnel = in_array($tags['tunnel'] ?? null, ['yes', 'building_passage'], true);
        foreach ($this->query($data, $a, $b) as $key) {
            $this->tick();
            if ($key[0] === 'p') {
                $obstacle = $data['polygons'][$key];
                $kind = $obstacle['kind'];
                if (WalkingGeometry::touches($a, $b, $obstacle['polygon']) && ! (! $connector && ($kind === 'water' && $bridge))) {
                    $issues[] = ($connector ? 'CONNECTOR_' : 'ROUTE_').strtoupper($kind);
                }
            } elseif ($key[0] === 'n') {
                if ($connector) {
                    $node = $data['nodes'][(int) substr($key, 1)];
                    if (WalkingGeometry::project($node['point'], $a, $b)[0] <= .25 && ($reason = $this->access($node['tags'], true))) {
                        $issues[] = $reason;
                    }
                }
            } else {
                $edge = $data['edges'][$key];
                $other = $edge['tags'];
                if (! WalkingGeometry::intersects($a, $b, $edge['a'], $edge['b'])) {
                    continue;
                }
                $barrier = in_array($other['barrier'] ?? null, ['wall', 'fence', 'retaining_wall'], true);
                $railway = in_array($other['railway'] ?? null, ['rail', 'narrow_gauge'], true);
                $shared = array_intersect($roadNodes, [$edge['u'], $edge['v']]);
                $layer = fn ($t) => isset($t['layer']) && preg_match('/^-?\d+$/', (string) $t['layer']) ? (int) $t['layer'] : null;
                $la = $layer($tags);
                $lb = $layer($other);
                $separated = ! $connector && ($bridge || $tunnel) && $la !== null && $lb !== null && $la !== $lb && ! $shared;
                $overlap = WalkingGeometry::overlap($a, $b, $edge['a'], $edge['b']);
                foreach (['barrier' => $barrier, 'railway' => $railway] as $hazard => $present) {
                    if (! $present) {
                        continue;
                    }
                    $crossing = false;
                    foreach ($shared as $nodeId) {
                        $nt = $data['nodes'][$nodeId]['tags'] ?? null;
                        // Crossings require explicit pedestrian permission and the exact shared original node.
                        if ($nt === null || $overlap || $this->access($nt, true) !== null || ! in_array($nt['foot'] ?? $nt['access'] ?? null, self::ALLOW, true)) {
                            continue;
                        }
                        if ($hazard === 'railway' && in_array($nt['railway'] ?? null, ['crossing', 'level_crossing'], true)) {
                            $crossing = true;
                        }
                        if ($hazard === 'barrier' && in_array($nt['barrier'] ?? null, self::GATES, true)) {
                            $crossing = true;
                        }
                    }
                    if (! $separated && ! $crossing) {
                        $issues[] = $hazard === 'barrier' ? 'BARRIER_REVIEW' : 'RAILWAY_LEVEL_OR_CROSSING_UNKNOWN';
                    }
                }
                if ($connector && isset($other['highway']) && ! in_array($other['highway'], ['footway', 'path', 'steps', 'pedestrian'], true)
                    && (WalkingGeometry::project($b, $edge['a'], $edge['b'])[0] > .25 || WalkingGeometry::project($a, $edge['a'], $edge['b'])[0] > .25)) {
                    $issues[] = 'CONNECTOR_ROAD_SIDE_UNKNOWN';
                }
            }
        }

        return array_values(array_unique($issues));
    }

    /** Maximal source-identity groups; pairwise proximity is deliberately not transitive. */
    private function groups(array $candidates, array $points): array
    {
        $byNode = [];
        $byEdge = [];
        $groups = [];
        foreach ($candidates as $i => $c) {
            $uv = [$c['u'], $c['v']];
            sort($uv);
            $byEdge[$c['way'].':'.implode(':', $uv)][] = $i;
            foreach (array_unique($uv) as $node) {
                if (isset($points[$node]) && WalkingGeometry::distance($c['point'], $points[$node]) <= 1 + 1e-9) {
                    $byNode[$node][] = $i;
                }
            }
        }
        foreach ($byNode as $indices) {
            sort($indices);
            $groups[implode(',', $indices)] = $indices;
        }
        foreach ($byEdge as $indices) {
            $neighbors = [];
            foreach ($indices as $i) {
                foreach ($indices as $j) {
                    if ($i !== $j && WalkingGeometry::distance($candidates[$i]['point'], $candidates[$j]['point']) <= .25 + 1e-9) {
                        $neighbors[$i][$j] = true;
                    }
                }
            }
            $visit = function ($chosen, $possible, $excluded) use (&$visit, &$groups, $neighbors) {
                $this->tick();
                if (! $possible && ! $excluded) {
                    sort($chosen);
                    $groups[implode(',', $chosen)] = $chosen;

                    return;
                }
                $union = array_unique([...$possible, ...$excluded]);
                $pivot = null;
                $best = -1;
                foreach ($union as $v) {
                    $n = count(array_intersect($possible, array_keys($neighbors[$v] ?? [])));
                    if ($n > $best) {
                        $best = $n;
                        $pivot = $v;
                    }
                }
                foreach (array_diff($possible, array_keys($neighbors[$pivot] ?? [])) as $v) {
                    $near = array_keys($neighbors[$v] ?? []);
                    $visit([...$chosen, $v], array_values(array_intersect($possible, $near)), array_values(array_intersect($excluded, $near)));
                    $possible = array_values(array_diff($possible, [$v]));
                    $excluded[] = $v;
                }
            };
            $visit([], $indices, []);
        }
        $maximal = [];
        foreach ($groups as $a) {
            foreach ($groups as $b) {
                if (count($a) < count($b) && ! array_diff($a, $b)) {
                    continue 2;
                }
            }
            $maximal[] = array_map(fn ($i) => $candidates[$i], $a);
        }

        return $maximal;
    }

    private function endpoint(array $original, ?array $actual, array $data): array
    {
        foreach ($this->query($data, $original, $original) as $key) {
            if ($key[0] === 'p' && WalkingGeometry::touches($original, $original, $data['polygons'][$key]['polygon'])) {
                return ['status' => 'NEEDS_REFINEMENT', 'checks' => ['ORIGINAL_IN_'.strtoupper($data['polygons'][$key]['kind'])]];
            }
        }
        if ($actual !== null) {
            if (WalkingGeometry::distance($original, $actual) > 20 + 1e-9) {
                return ['status' => 'NEEDS_REFINEMENT', 'checks' => ['SOURCE_ENDPOINT_OUTSIDE_RADIUS']];
            }
            if (WalkingGeometry::distance($original, $actual) > 1e-7 && ($issues = $this->conflicts($original, $actual, $data))) {
                return ['status' => 'NEEDS_REFINEMENT', 'checks' => $issues];
            }
        }
        $candidates = [];
        foreach ($this->query($data, $original, $original, 20.25) as $key) {
            if ($key[0] !== 'e') {
                continue;
            }
            $edge = $data['edges'][$key];
            if (! isset($edge['tags']['highway']) || $this->access($edge['tags']) !== null) {
                continue;
            }
            foreach ([$edge['u'], $edge['v']] as $node) {
                if (isset($data['nodes'][$node]) && $this->access($data['nodes'][$node]['tags'], true) !== null) {
                    continue 2;
                }
            }
            [$gap,$point,$fraction] = WalkingGeometry::project($original, $edge['a'], $edge['b']);
            if ($gap <= 20 + 1e-9) {
                $candidates[] = ['gap' => $gap, 'point' => $point, 'way' => $edge['way'], 'u' => $edge['u'], 'v' => $edge['v'],
                    'coordinate' => WalkingGeometry::point($edge['coordinates'][0], $edge['coordinates'][1], $fraction)];
            }
            if (count($candidates) > 64) {
                throw new RoutingDataException('Walking endpoint candidate budget');
            }
        }
        if (! $candidates) {
            return ['status' => 'NONE', 'checks' => ['NO_SOURCE_POLICY_SNAP']];
        }
        $best = min(array_column($candidates, 'gap'));
        $candidates = array_values(array_filter($candidates, fn ($c) => $c['gap'] <= $best + 1 + 1e-9));
        $groups = $this->groups($candidates, $data['points']);
        if (count($groups) > 1) {
            return ['status' => 'CHOOSE', 'checks' => ['DISTINCT_SOURCE_JUNCTION_OR_EDGE_CHOICES'], 'groups' => $groups];
        }
        foreach ($groups[0] as $candidate) {
            if (WalkingGeometry::distance($original, $candidate['point']) > 1e-7 && ($issues = $this->conflicts($original, $candidate['point'], $data))) {
                return ['status' => 'NEEDS_REFINEMENT', 'checks' => $issues];
            }
        }
        if ($actual !== null) {
            $equivalent = false;
            $shared = null;
            foreach ($groups[0] as $c) {
                if (WalkingGeometry::distance($actual, $c['point']) <= .25 + 1e-9) {
                    $equivalent = true;
                }
                $shared = $shared === null ? [$c['u'], $c['v']] : array_intersect($shared, [$c['u'], $c['v']]);
            }
            foreach ($shared ?? [] as $node) {
                if (WalkingGeometry::distance($actual, $data['points'][$node]) > .25 + 1e-9) {
                    continue;
                }
                foreach ($groups[0] as $c) {
                    if (WalkingGeometry::distance($c['point'], $data['points'][$node]) > 1 + 1e-9) {
                        continue 2;
                    }
                }
                $equivalent = true;
            }
            if (! $equivalent) {
                return ['status' => 'NONE', 'checks' => ['ENGINE_ENDPOINT_DIFFERS_FROM_SOURCE_CANDIDATE']];
            }
        }

        return ['status' => 'SELECTED', 'checks' => [], 'groups' => $groups];
    }

    private function edgeIdentity(array $candidate): string
    {
        return $candidate['way'].':'.min($candidate['u'], $candidate['v']).':'.max($candidate['u'], $candidate['v']);
    }

    /** Fresh endpoint neighbourhood, without resetting this request's work or numeric budgets. */
    private function pointData(WalkingRoutingSnapshot $snapshot, array $point, array $original): array
    {
        $dy = 20.5 / 110000;
        $dx = $dy / max(.1, cos(deg2rad($point['lat'])));
        $features = $snapshot->features([[$point['lon'] - $dx, $point['lat'] - $dy], [$point['lon'] + $dx, $point['lat'] + $dy]], $original, $point);
        $this->tick();
        $this->activeCells = [];
        $this->restrictCells([[$point['lon'], $point['lat']]], $original, $point);

        return $this->prepare($features);
    }

    /** Suggestions remain choices; each must independently resolve on its original source group. */
    private function suggestions(WalkingRoutingSnapshot $snapshot, array $original, array $groups, array $area): array
    {
        usort($groups, fn ($a, $b) => min(array_column($a, 'gap')) <=> min(array_column($b, 'gap')));
        $result = [];
        $seenPoints = [];
        $seenGroups = [];
        $attempts = 0;
        $origin = $this->xy($original);
        foreach ($groups as $group) {
            $identities = array_values(array_unique(array_map($this->edgeIdentity(...), $group)));
            sort($identities);
            $groupKey = implode(',', $identities);
            if (isset($seenGroups[$groupKey])) {
                continue;
            }
            $seenGroups[$groupKey] = true;
            usort($group, fn ($a, $b) => $a['gap'] <=> $b['gap']);
            foreach ($group as $proposal) {
                $this->tick();
                $coordinate = $proposal['coordinate'];
                $point = ['lon' => $coordinate[0], 'lat' => $coordinate[1]];
                $xy = $this->xy($point);
                $gap = WalkingGeometry::distance($origin, $xy);
                if ($gap > 20 + 1e-9 || ! $this->edgeCovered($origin, $xy, $area)) {
                    continue;
                }
                foreach ($seenPoints as $seen) {
                    if (WalkingGeometry::distance($xy, $seen) <= .25 + 1e-9) {
                        continue 2;
                    }
                }
                $seenPoints[] = $xy;
                if (++$attempts > 12) {
                    return $result;
                }
                $data = $this->pointData($snapshot, $point, $original);
                // Check even a zero-length connector: a point on a barrier/rail line is not a safe suggestion.
                if ($this->conflicts($origin, $xy, $data)) {
                    continue;
                }
                $resolved = $this->endpoint($xy, null, $data);
                if ($resolved['status'] !== 'SELECTED') {
                    continue;
                }
                $selected = $resolved['groups'][0];
                $selectedIdentities = array_values(array_unique(array_map($this->edgeIdentity(...), $selected)));
                // A new neighbourhood may reveal another, closer street. Never relabel that as this proposal.
                if (! in_array($this->edgeIdentity($proposal), $selectedIdentities, true)) {
                    continue;
                }
                $result[] = ['point' => $point, 'distance_m' => $gap];
                if (count($result) === 6) {
                    return $result;
                }
                break; // One suggestion per original source group.
            }
        }

        return $result;
    }

    /** CHOOSE carries at most six explicit, revalidated source-edge choices; it never auto-selects one. */
    public function validatePoint(WalkingRoutingSnapshot $snapshot, array $point): array
    {
        $this->begin();
        try {
            $area = $this->area($snapshot->manifest());
            if (! $this->covered($this->xy($point), $area)) {
                return $this->result('OUTSIDE_PILOT', ['OUTSIDE_CONFIRMED_COVERAGE']) + ['point' => null, 'candidates' => []];
            }
            $data = $this->pointData($snapshot, $point, $point);
            $end = $this->endpoint($this->xy($point), null, $data);
            unset($data);
            $candidates = $end['status'] === 'CHOOSE' ? $this->suggestions($snapshot, $point, $end['groups'], $area) : [];

            return $this->result($end['status'], $end['checks']) + ['point' => $end['status'] === 'SELECTED' ? $point : null, 'candidates' => $candidates];
        } catch (\Throwable) {
            return $this->result('UNKNOWN', ['SOURCE_DATA_OR_BUDGET_UNAVAILABLE']) + ['point' => null, 'candidates' => []];
        } finally {
            WalkingGeometry::budget(null);
        }
    }

    private function response(array $body): array
    {
        if (($body['type'] ?? null) !== 'FeatureCollection' || ! is_array($body['features'] ?? null) || count($body['features']) !== 1) {
            throw new RoutingDataException('EXPECTED_SINGLE_GEOJSON_FEATURE');
        }
        $f = $body['features'][0];
        $g = $f['geometry'] ?? [];
        $coords = $g['coordinates'] ?? null;
        $summary = $f['properties']['summary'] ?? [];
        if (($g['type'] ?? null) !== 'LineString' || ! is_array($coords) || count($coords) < 2 || count($coords) > 10000 || ! array_is_list($coords)) {
            throw new RoutingDataException('INVALID_FULL_LINE');
        }
        foreach ($coords as $p) {
            if (! WalkingGeometry::coordinate($p)) {
                throw new RoutingDataException('INVALID_COORDINATES');
            }
        }
        foreach (['distance', 'duration'] as $key) {
            $v = $summary[$key] ?? null;
            if ((! is_float($v) && ! is_int($v)) || ! is_finite((float) $v) || $v < 0) {
                throw new RoutingDataException('INVALID_MEASURES');
            }
        }
        if ($summary['distance'] <= 0 || $summary['duration'] <= 0) {
            throw new RoutingDataException('INVALID_POSITIVE_ROUTE_MEASURES');
        }
        $values = $f['properties']['extras']['osmId']['values'] ?? $f['properties']['extras']['osmid']['values'] ?? null;
        if (! is_array($values) || count($values) > 10000) {
            throw new RoutingDataException('MISSING_OSMID_RANGES');
        }
        $ids = array_fill(0, count($coords) - 1, null);
        foreach ($values as $range) {
            if (! is_array($range) || count($range) !== 3 || ! array_is_list($range)) {
                throw new RoutingDataException('INVALID_OSMID_RANGE');
            }
            [$first,$last,$way] = $range;
            if (! is_int($first) || ! is_int($last) || ! is_int($way) || $first < 0 || $first >= $last || $last >= count($coords) || $way < 1) {
                throw new RoutingDataException('INVALID_OSMID_RANGE');
            }
            for ($i = $first; $i < $last; $i++) {
                $this->tick();
                if ($ids[$i] !== null && $ids[$i] !== $way) {
                    throw new RoutingDataException('INCOMPLETE_OR_AMBIGUOUS_OSMID');
                }
                $ids[$i] = $way;
            }
        }
        if (in_array(null, $ids, true)) {
            throw new RoutingDataException('INCOMPLETE_OR_AMBIGUOUS_OSMID');
        }

        return [$coords, $summary, $ids];
    }

    public function review(WalkingRoutingSnapshot $snapshot, array $body, array $start, array $target): array
    {
        $this->begin();
        try {
            $area = $this->area($snapshot->manifest());
            if (! $this->covered($this->xy($start), $area) || ! $this->covered($this->xy($target), $area)) {
                return $this->result('OUTSIDE_PILOT', ['OUTSIDE_CONFIRMED_COVERAGE']);
            }
            [$coordinates,$summary,$ids] = $this->response($body);
            $chain = (new WalkingSourceChain($snapshot->ways(array_values(array_unique($ids)))))->match($coordinates, $ids);
            $pieces = $chain['segments'];
            $original = [];
            foreach ($pieces as $p) {
                array_push($original, ...$p['coordinates']);
            }
            // Prepared cells follow the original source curve, including simplified-away bends.
            $this->restrictCells($original ?: $coordinates, $start, $target);
            $data = $this->prepare($snapshot->features($original ?: $coordinates, $start, $target));
            $first = array_values(array_filter($pieces, fn ($p) => $p['raw_segment_index'] === 0));
            $last = array_values(array_filter($pieces, fn ($p) => $p['raw_segment_index'] === count($coordinates) - 2));
            $ends = [$this->endpoint($this->xy($start), $first ? $first[0]['a'] : null, $data), $this->endpoint($this->xy($target), $last ? $last[array_key_last($last)]['b'] : null, $data)];
            $issues = $chain['reasons'];
            $length = 0;
            $canonical = [];
            $coverage = true;
            foreach ($pieces as $p) {
                $this->tick();
                if (($reason = $this->access($p['tags'])) !== null) {
                    $issues[] = $reason;
                }
                foreach ([$p['start_node'], $p['end_node']] as $node) {
                    if ($node !== null && isset($data['nodes'][$node]) && ($reason = $this->access($data['nodes'][$node]['tags'], true)) !== null) {
                        $issues[] = $reason;
                    }
                }
                array_push($issues, ...$this->conflicts($p['a'], $p['b'], $data, $p));
                $coverage = $coverage && $this->edgeCovered($p['a'], $p['b'], $area);
                $length += WalkingGeometry::distance($p['a'], $p['b']);
                if (! $canonical) {
                    $canonical[] = $p['coordinates'][0];
                }
                $canonical[] = $p['coordinates'][1];
            }
            $raw = array_map(WalkingGeometry::utm(...), $coordinates);
            $rawLength = 0;
            for ($i = 1; $i < count($raw); $i++) {
                $rawLength += WalkingGeometry::distance($raw[$i - 1], $raw[$i]);
                $coverage = $coverage && $this->edgeCovered($raw[$i - 1], $raw[$i], $area);
            }
            if (! $coverage) {
                return $this->result('OUTSIDE_PILOT', ['LINE_OUTSIDE_CONFIRMED_SCOPE']);
            }
            if (abs($summary['distance'] - $rawLength) > max(5, .02 * $rawLength) || ($chain['status'] === 'MATCHED' && abs($summary['distance'] - $length) > max(5, .02 * $length))) {
                $issues[] = 'LENGTH_MISMATCH';
            }
            foreach ($ends as $end) {
                array_push($issues, ...$end['checks']);
            }
            if (array_intersect(array_column($ends, 'status'), ['NEEDS_REFINEMENT', 'CHOOSE'])) {
                return $this->result('NEEDS_REFINEMENT', $issues);
            }
            if ($chain['status'] !== 'MATCHED' || $issues || array_column($ends, 'status') !== ['SELECTED', 'SELECTED']) {
                return $this->result('UNKNOWN', $issues ?: ['SOURCE_MODEL_NOT_CONFIRMED']);
            }

            return array_merge($this->result('AVAILABLE', []), ['geometry' => ['type' => 'LineString', 'coordinates' => $canonical], 'distance_m' => $length, 'geometry_distance_m' => $length, 'duration_s' => (float) $summary['duration']]);
        } catch (\Throwable) {
            return $this->result('UNKNOWN', ['SOURCE_DATA_OR_BUDGET_UNAVAILABLE']);
        } finally {
            WalkingGeometry::budget(null);
        }
    }

    private function result(string $status, array $issues): array
    {
        return ['status' => $status, 'reason' => match ($status) {
            'AVAILABLE' => 'Путь согласован с сохранённой моделью пешеходных данных. Реальный проход и время не проверены.',
            'SELECTED' => 'Точка согласована с локальными пешеходными данными.',
            'OUTSIDE_PILOT' => 'Точка или путь выходит за подтверждённую территорию пешего пилота.',
            'NEEDS_REFINEMENT','CHOOSE' => 'Уточните точку на доступной улице: подход или привязка неоднозначны.',
            default => 'Геометрию или пешеходный доступ не удалось подтвердить по локальным данным.',
        }, 'checks' => array_values(array_unique($issues)), 'geometry' => null, 'distance_m' => null, 'duration_s' => null];
    }
}
