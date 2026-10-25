<?php

namespace App\Services\Routing;

use Illuminate\Support\Facades\DB;

class RoutingGeometryGuard
{
    // OSRM GeoJSON precision: source geometry matching only, never an access-length cutoff.
    public const SOURCE_TOLERANCE_M = 0.25;

    public function scope(RoutingSnapshot $snapshot, array $start, array $target): bool
    {
        $m = $snapshot->manifest();
        $row = DB::transaction(function () use ($m, $start, $target) {
            DB::statement('SET TRANSACTION READ ONLY');
            DB::statement("SET LOCAL statement_timeout = '1500ms'");
            DB::statement('SET LOCAL jit = off');

            return DB::selectOne(<<<'SQL'
                WITH area AS (
                    SELECT ST_Intersection(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646),
                        ST_Buffer(ST_Transform(ST_MakeEnvelope(?,?,?,?,4326),32646),-CAST(? AS double precision))) geom
                ) SELECT ST_Covers(geom,ST_Transform(ST_SetSRID(ST_MakePoint(?,?),4326),32646))
                    AND ST_Covers(geom,ST_Transform(ST_SetSRID(ST_MakePoint(?,?),4326),32646)) covered FROM area
                SQL, [json_encode($m['guard_sources']['service_geometry']), ...$m['bbox'], $m['boundary_margin_m'], $start['lon'], $start['lat'], $target['lon'], $target['lat']]);
        });

        return (bool) $row->covered;
    }

    public function review(RoutingSnapshot $snapshot, array $line, array $start, array $target, array $nodes): array
    {
        if (count($nodes) < 2) {
            return ['status' => 'UNKNOWN', 'reason' => 'Недостаточно исходных узлов для проверки доступа на пути.', 'checks' => ['SOURCE_ANNOTATIONS_INSUFFICIENT'],
                'diagnostic_issues' => [TripDiagnostics::issue('SOURCE_ANNOTATIONS_INSUFFICIENT', 'route', 'geometry')]];
        }
        $features = $snapshot->features($line['coordinates'], $start, $target);
        $features = $this->prepareFeatures($features);
        $direction = $this->sourceChecks($features, $nodes);
        $manifest = $snapshot->manifest();
        $bindings = [json_encode($line), json_encode(['type' => 'Point', 'coordinates' => [$start['lon'], $start['lat']]]),
            json_encode(['type' => 'Point', 'coordinates' => [$target['lon'], $target['lat']]]), json_encode($features),
            json_encode($manifest['guard_sources']['service_geometry']), json_encode($manifest['bbox']), $manifest['boundary_margin_m'],
            json_encode($nodes), self::SOURCE_TOLERANCE_M];
        $review = DB::transaction(function () use ($bindings) {
            DB::statement('SET TRANSACTION READ ONLY');
            DB::statement("SET LOCAL statement_timeout = '1500ms'");
            DB::statement('SET LOCAL jit = off');

            return (array) DB::selectOne($this->sql('geometry.sql'), $bindings);
        });
        $issues = json_decode($review['issues'] ?? '{}', true);
        $issues = array_merge($issues, $direction);
        $details = array_map(fn ($i) => TripDiagnostics::issue($i['code'], $i['endpoint'], $i['stage']),
            json_decode($review['connector_diagnostics'] ?? '[]', true) ?? []);
        foreach (array_diff(array_keys($issues), array_column($details, 'code')) as $code) {
            $details[] = TripDiagnostics::issue($code, 'route', 'geometry');
        }
        if (! $review['in_scope']) {
            return ['status' => 'OUTSIDE_PILOT', 'reason' => 'Путь выходит за подтверждённую территорию пилота или проходит слишком близко к границе графа.', 'checks' => ['OUTSIDE_CONFIRMED_COVERAGE'],
                'diagnostic_issues' => [TripDiagnostics::issue('OUTSIDE_CONFIRMED_COVERAGE', 'route', 'geometry')]];
        }
        $refine = ['START_IN_BUILDING', 'TARGET_IN_BUILDING', 'SNAP_THROUGH_BUILDING', 'SNAP_THROUGH_BARRIER', 'SNAP_THROUGH_WATER', 'SNAP_CROSSES_ROAD', 'SNAP_NODE_ACCESS_UNKNOWN', 'SNAP_THROUGH_RAILWAY'];
        if (array_intersect($refine, array_keys($issues))) {
            return ['status' => 'NEEDS_REFINEMENT', 'reason' => 'Подход к дорожной точке не подтверждён: возможно здание, ограда, вода или другая сторона дороги. Уточните исходную точку на доступной улице.', 'checks' => array_keys($issues), 'diagnostic_issues' => $details];
        }
        $length = (float) $review['length_m'];
        if ($issues || ($length > .01 && (float) $review['covered_length_m'] < .97 * $length) || ($length <= .01 && ! $review['on_network'])) {
            return ['status' => 'UNKNOWN', 'reason' => 'Геометрию или доступ на части пути не удалось подтвердить по локальным данным. Выберите другую дорожную точку.', 'checks' => array_keys($issues) ?: ['INCOMPLETE_SOURCE_MATCH'],
                'diagnostic_issues' => $details ?: [TripDiagnostics::issue('INCOMPLETE_SOURCE_MATCH', 'route', 'geometry')]];
        }

        return ['status' => 'AVAILABLE', 'reason' => 'Путь и обе привязки прошли проверки известных препятствий в статической модели. Вход, парковка и реальный доступ не подтверждены.', 'checks' => [], 'geometry_distance_m' => $length];
    }

    /** Local prepared roads only. A selected point is not a confirmed entrance. */
    public function resolve(RoutingSnapshot $snapshot, array $original, ?array $hint = null): array
    {
        $m = $snapshot->manifest();
        $manual = $hint !== null;
        $hint ??= $original;
        if ($manual && ! $this->scope($snapshot, $original, $hint)) {
            return ['status' => 'NONE', 'point' => null, 'candidates' => [], 'checks' => ['OUTSIDE_CONFIRMED_COVERAGE']];
        }
        $radius = $m['snap_limit_m'];
        $dy = ($radius + self::SOURCE_TOLERANCE_M) / 110000;
        $dx = $dy / max(.1, cos(deg2rad($original['lat'])));
        $features = $this->prepareFeatures($snapshot->features([
            [$original['lon'] - $dx, $original['lat'] - $dy], [$original['lon'] + $dx, $original['lat'] + $dy],
        ], $original, $original));
        $bindings = [$original['lon'], $original['lat'], $hint['lon'], $hint['lat'], $radius,
            json_encode($features), json_encode($m['guard_sources']['service_geometry']), json_encode($m['bbox']), $m['boundary_margin_m'], $manual ? 1 : 0];
        $rows = DB::transaction(function () use ($bindings) {
            DB::statement('SET TRANSACTION READ ONLY');
            DB::statement("SET LOCAL statement_timeout = '1500ms'");
            DB::statement('SET LOCAL jit = off');

            return DB::select($this->sql('snap-candidates.sql'), $bindings);
        });
        $diagnostics = json_decode($rows[0]->diagnostics ?? '{}', true);
        if (count($rows) === 1 && $rows[0]->point === null) {
            return ['status' => 'NONE', 'point' => null, 'candidates' => [],
                'checks' => array_values(array_unique(['SNAP_NO_SAFE_CANDIDATE', ...json_decode($rows[0]->checks, true)])), 'diagnostics' => $diagnostics];
        }
        if (count($rows) > 16) {
            return ['status' => 'NONE', 'point' => null, 'candidates' => [], 'issue' => 'CANDIDATE_BUDGET', 'diagnostics' => $diagnostics]; // Bounded search must not silently omit alternatives.
        }
        if ($manual) {
            $exact = array_values(array_filter($rows, fn ($r) => (float) $r->hint_distance_m <= self::SOURCE_TOLERANCE_M));
            if ($exact) {
                $rows = $exact;
            }
        }
        $byId = array_column(array_filter($features, fn ($f) => $f['kind'] === 'line'), null, 'id');
        $choices = [];
        foreach ($rows as $row) {
            $point = json_decode($row->point, true)['coordinates'];
            $junctions = [];
            $feature = $byId[$row->source_id];
            $name = $feature['tags']['name'] ?? null;
            $name = is_string($name) && trim($name) !== '' && mb_strlen($name) <= 160 ? trim($name) : null;
            foreach ($feature['nodes'] as $i => $node) {
                $coord = $feature['geometry']['coordinates'][$i];
                if ($this->pointDistance($coord, $point) <= self::SOURCE_TOLERANCE_M) {
                    $junctions[] = $node;
                }
            }
            foreach ($choices as $i => $choice) {
                if (array_intersect($junctions, $choice['junctions'])
                    && $this->pointDistance($point, [$choice['point']['lon'], $choice['point']['lat']]) <= self::SOURCE_TOLERANCE_M) {
                    if (($choice['name'] ?? null) !== $name) {
                        unset($choices[$i]['name']); // A shared junction does not establish one road name.
                    }

                    continue 2; // Same source junction, not merely nearby parallel carriageways.
                }
            }
            $choices[] = ['point' => ['lon' => $point[0], 'lat' => $point[1]], 'distance_m' => (float) $row->distance_m, 'junctions' => $junctions];
            if ($name !== null) {
                $choices[array_key_last($choices)]['name'] = $name;
            }
        }
        $choices = array_map(fn ($c) => array_diff_key($c, ['junctions' => true]), $choices);

        return ['status' => count($choices) === 1 ? 'SELECTED' : (count($choices) ? 'CHOOSE' : 'NONE'),
            'point' => count($choices) === 1 ? $choices[0]['point'] : null, 'candidates' => $choices, 'manual' => $manual, 'diagnostics' => $diagnostics];
    }

    private function pointDistance(array $a, array $b): float
    {
        $lat1 = deg2rad($a[1]);
        $lat2 = deg2rad($b[1]);
        $h = sin(($lat2 - $lat1) / 2) ** 2 + cos($lat1) * cos($lat2) * sin(deg2rad($b[0] - $a[0]) / 2) ** 2;

        return 12742017.6 * asin(min(1, sqrt($h)));
    }

    private function prepareFeatures(array $features): array
    {
        foreach ($features as &$feature) {
            $tags = $feature['tags'] ?? [];
            $feature['access_allowed'] = $this->allowsAccess($tags, $feature['kind'] !== 'node')
                && ! $this->hasOtherConditions($tags)
                && ! ($feature['kind'] === 'node' && ($tags['locked'] ?? '') === 'yes');
        }

        return $features;
    }

    private function sql(string $name): string
    {
        return str_replace('/* SNAP_ISSUES */', file_get_contents(__DIR__.'/connector-issues.sql'), file_get_contents(__DIR__.'/'.$name));
    }

    private function allowsAccess(array $tags, bool $default): bool
    {
        foreach (['motorcar', 'motor_vehicle', 'vehicle', 'access'] as $key) {
            // No date/time/permit context: an applicable conditional cannot establish permission.
            if (array_key_exists($key.':conditional', $tags)) {
                return false;
            }
            if (array_key_exists($key, $tags)) {
                return in_array($tags[$key], ['yes', 'designated', 'permissive'], true);
            }
        }

        return $default;
    }

    private function sourceChecks(array $features, array $nodes): array
    {
        $issues = [];
        $nodeIds = array_fill_keys($nodes, true);
        $wanted = [];
        foreach (array_slice($nodes, 1) as $i => $node) {
            if ($nodes[$i] !== $node) {
                $wanted[$nodes[$i].':'.$node] = [];
            }
        }
        foreach ($features as $feature) {
            if ($feature['kind'] === 'node' && isset($nodeIds[substr($feature['id'], 5)])
                && ! $feature['access_allowed']) {
                $issues['SOURCE_NODE_ACCESS_UNKNOWN'] = true;
            }
            if ($feature['kind'] !== 'line' || ! isset($feature['tags']['highway'])) {
                continue;
            }
            $tags = $feature['tags'];
            $conditional = $this->hasOtherConditions($tags);
            $oneway = $tags['oneway:motorcar'] ?? $tags['oneway:motor_vehicle'] ?? $tags['oneway:vehicle'] ?? $tags['oneway'] ?? (($tags['junction'] ?? '') === 'roundabout' ? 'yes' : 'no');
            foreach (array_slice($feature['nodes'], 1) as $i => $node) {
                $a = $feature['nodes'][$i];
                foreach ([[$a, $node, ! in_array($oneway, ['-1', 'reverse'], true)], [$node, $a, ! in_array($oneway, ['yes', '1', 'true'], true)]] as [$from, $to, $allowed]) {
                    $key = $from.':'.$to;
                    if (array_key_exists($key, $wanted)) {
                        $wanted[$key][] = $allowed && ! $conditional;
                        if (! $feature['access_allowed']) {
                            $issues['SOURCE_EDGE_ACCESS_UNKNOWN'] = true;
                        }
                    }
                }
            }
        }
        foreach ($wanted as $matches) {
            if (! in_array(true, $matches, true)) {
                $issues['SOURCE_DIRECTION_OR_CONDITION_UNKNOWN'] = true;
            }
        }

        return $issues;
    }

    private function hasOtherConditions(array $tags): bool
    {
        return count(array_filter(array_keys($tags), fn ($key) => str_contains($key, 'conditional')
            && ! in_array($key, ['motorcar:conditional', 'motor_vehicle:conditional', 'vehicle:conditional', 'access:conditional'], true))) > 0;
    }
}
