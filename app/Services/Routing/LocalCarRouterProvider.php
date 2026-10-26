<?php

namespace App\Services\Routing;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Throwable;

class LocalCarRouterProvider
{
    private array $resolved = [];

    public function __construct(private RoutingSnapshot $snapshot, private RoutingGeometryGuard $guard) {}

    /** A bounded 1×N matrix, with an independently verified route for each cell. */
    public function analyze(array $start, array $places): array
    {
        $this->resolved = [];
        $startRoad = isset($start['road']) ? $this->point($start['road']) : null;
        $start = $this->point($start);
        $source = null;
        try {
            $manifest = $this->snapshot->manifest();
            $source = ['name' => 'OpenStreetMap', 'engine' => 'OSRM', 'engine_version' => $manifest['engine_version'],
                'profile' => 'car', 'dataset_version' => $manifest['version'], 'pbf_sha256' => $manifest['pbf_sha256'],
                'extract_sha256' => $manifest['extract_sha256'], 'manifest_sha256' => config('routing.manifest_sha256'),
                'observed_at' => $manifest['observed_at'], 'prepared_at' => $manifest['prepared_at'],
                'guard_imports' => $manifest['guard_sources']['imports'], 'pilot_bbox' => $manifest['bbox']];
        } catch (Throwable) {
            // Missing/corrupt preparation must not become a fabricated route.
        }
        $rows = [];
        foreach ($places as $i => $place) {
            $target = $this->point($place);
            $row = ['index' => $i, 'label' => trim($place['label'] ?? '') ?: 'Место '.($i + 1),
                'start' => $start, 'target' => $target, 'status' => 'UNAVAILABLE',
                'reason' => 'Локальные данные маршрутизации не подготовлены или изменились.',
                'route' => null, 'snaps' => null, 'checks' => $source === null ? ['ROUTING_DATA_UNAVAILABLE'] : [], 'road_choices' => null];
            if ($source !== null) {
                try {
                    $row = array_replace($row, $this->pair($start, $target, $manifest, $startRoad, isset($place['road']) ? $this->point($place['road']) : null));
                } catch (ConnectionException) {
                    $row = array_replace($row, ['status' => 'UNAVAILABLE', 'reason' => 'Маршрутизатор временно недоступен. Повторите расчёт позже.', 'checks' => ['ROUTER_UNAVAILABLE']]);
                } catch (Throwable) {
                    $row = array_replace($row, ['status' => 'UNKNOWN', 'reason' => 'Проверить путь по локальным данным не удалось. Повторите расчёт или уточните точки.', 'checks' => ['ROUTE_CHECK_FAILED']]);
                }
            }
            $details = $row['diagnostic_issues'] ?? array_map(
                fn ($code) => TripDiagnostics::issue($code), $row['checks']);
            if (! $details && $row['status'] !== 'AVAILABLE') {
                $details = [TripDiagnostics::issue(match ($row['status']) {
                    'NO_PATH' => 'NO_ROUTE',
                    'UNAVAILABLE' => 'ROUTER_UNAVAILABLE',
                    default => 'ROUTE_NOT_CONFIRMED',
                })];
            }
            $row['diagnostics'] = TripDiagnostics::envelope($details, $i);
            unset($row['diagnostic_issues']);
            $at = now('UTC')->toIso8601String();
            $row['metrics'] = [
                'distance' => $this->metric('route_distance', $row['route']['distance_m'] ?? null, 'm', $row, $source, $at),
                'duration' => $this->metric('route_duration', $row['route']['duration_s'] ?? null, 's', $row, $source, $at),
            ];
            $rows[] = $row;
        }

        return ['mode' => 'driving', 'start' => $start, 'results' => $rows, 'source' => $source,
            'limitation' => 'Модельное время без актуальных пробок. Обычное городское время не подтверждено; парковка и путь от здания до дороги не учтены. Привязка не подтверждает вход или доступ к месту.'];
    }

    private function pair(array $start, array $target, array $manifest, ?array $startRoad, ?array $targetRoad): array
    {
        $outside = [];
        foreach (['start' => $start, 'target' => $target] as $end => $point) {
            if (! $this->snapshot->contains($point) || ! $this->guard->scope($this->snapshot, $point, $point)) {
                $outside[] = TripDiagnostics::issue('OUTSIDE_CONFIRMED_COVERAGE', $end, 'scope');
            }
        }
        if ($outside) {
            return ['status' => 'OUTSIDE_PILOT', 'reason' => 'Одна из точек вне территории автомобильного пилота. Выберите точку в Красноярске.', 'checks' => ['OUTSIDE_CONFIRMED_COVERAGE'], 'diagnostic_issues' => $outside];
        }
        $choices = [];
        foreach (['start' => [$start, $startRoad], 'target' => [$target, $targetRoad]] as $key => [$original, $hint]) {
            $cacheKey = json_encode([$original, $hint]);
            try {
                $choices[$key] = $this->resolved[$cacheKey] ??= $this->guard->resolve($this->snapshot, $original, $hint);
            } catch (RoutingDataException) {
                $choices[$key] = ['status' => 'NONE', 'point' => null, 'candidates' => [], 'checks' => ['SNAP_DATA_UNAVAILABLE']];
            } catch (Throwable) {
                $choices[$key] = ['status' => 'NONE', 'point' => null, 'candidates' => [], 'checks' => ['SNAP_CHECK_FAILED']];
            }
        }
        if ($choices['start']['status'] !== 'SELECTED' || $choices['target']['status'] !== 'SELECTED') {
            $checks = [];
            $details = [];
            foreach ($choices as $end => $choice) {
                if ($choice['status'] !== 'SELECTED') {
                    $codes = [...($choice['checks'] ?? []), match ($choice['status']) {
                        'CHOOSE' => 'SNAP_CHOICE_REQUIRED',
                        default => array_intersect(['SNAP_DATA_UNAVAILABLE', 'SNAP_CHECK_FAILED'], $choice['checks'] ?? [])
                            ? 'ROUTE_CHECK_FAILED' : (isset($choice['issue']) ? 'SNAP_CANDIDATE_BUDGET' : 'SNAP_NO_SAFE_CANDIDATE'),
                    }];
                    $checks = [...$checks, ...$codes];
                    // The general legacy code is kept in checks, but is not a second cause.
                    foreach (array_diff(array_unique($codes), count(array_unique($codes)) > 1 ? ['SNAP_NO_SAFE_CANDIDATE', 'ROUTE_CHECK_FAILED'] : []) as $code) {
                        $details[] = TripDiagnostics::issue($code, $end, 'snap');
                    }
                }
            }
            $failed = in_array('ROUTE_CHECK_FAILED', $checks, true);

            return ['status' => $failed ? 'UNKNOWN' : 'NEEDS_REFINEMENT', 'road_choices' => $choices,
                'checks' => array_values(array_unique($checks)),
                'diagnostic_issues' => $details,
                'reason' => $failed ? 'Проверить привязку по локальным данным не удалось. Повторите расчёт позже.' : (in_array('CANDIDATE_BUDGET', array_column($choices, 'issue'), true)
                    ? 'Рядом слишком много дорожных вариантов для уверенного выбора. Передвиньте точку ближе к нужному подъезду или проезду.'
                    : (in_array('CHOOSE', array_column($choices, 'status'), true)
                    ? 'Рядом несколько подходящих дорожных точек. Выберите вариант на карте или в списке.'
                    : 'Безопасная дорожная точка в пределах 35 м не найдена. Передвиньте исходную точку ближе к нужному подъезду или проезду.'))];
        }
        $a = $choices['start']['point'];
        $b = $choices['target']['point'];
        // All results after this point retain the independently checked road choices.
        try {
            $result = $this->route($start, $target, $a, $b, $manifest);
        } catch (ConnectionException) {
            $result = ['status' => 'UNAVAILABLE', 'reason' => 'Маршрутизатор временно недоступен. Повторите расчёт позже.', 'checks' => ['ROUTER_UNAVAILABLE']];
        } catch (RoutingDataException) {
            $result = ['status' => 'UNKNOWN', 'reason' => 'Проверить путь по локальным данным не удалось. Повторите расчёт или уточните точки.', 'checks' => ['ROUTE_CHECK_FAILED'],
                'diagnostic_issues' => [TripDiagnostics::issue('ROUTE_DATA_UNAVAILABLE', 'unknown', 'geometry')]];
        } catch (Throwable) {
            $result = ['status' => 'UNKNOWN', 'reason' => 'Проверить путь по локальным данным не удалось. Повторите расчёт или уточните точки.', 'checks' => ['ROUTE_CHECK_FAILED']];
        }

        return $result + ['road_choices' => $choices];
    }

    private function route(array $start, array $target, array $a, array $b, array $manifest): array
    {
        $coordinates = $a['lon'].','.$a['lat'].';'.$b['lon'].','.$b['lat'];
        $began = microtime(true);
        $maximum = config('routing.max_response_bytes');
        $response = Http::connectTimeout(config('routing.connect_timeout_s'))->timeout(config('routing.timeout_s'))
            ->withHeaders(['Accept-Encoding' => 'identity'])
            ->withOptions(['allow_redirects' => false, 'decode_content' => false,
                'progress' => function ($total, $downloaded) use ($began, $maximum) {
                    if ($total > $maximum || $downloaded > $maximum || microtime(true) - $began > config('routing.timeout_s')) {
                        throw new \RuntimeException('Router transfer budget exceeded');
                    }
                }])
            ->get(config('routing.url').'/route/v1/driving/'.$coordinates, [
                'radiuses' => RoutingGeometryGuard::SOURCE_TOLERANCE_M.';'.RoutingGeometryGuard::SOURCE_TOLERANCE_M,
                'overview' => 'full', 'geometries' => 'geojson', 'annotations' => 'nodes', 'alternatives' => 'false',
            ]);
        if ($response->status() >= 500 || $response->redirect()) {
            return ['status' => 'UNAVAILABLE', 'reason' => 'Локальный маршрутизатор временно недоступен. Повторите расчёт позже.', 'checks' => ['ROUTER_UNAVAILABLE']];
        }
        $stream = $response->toPsrResponse()->getBody();
        $body = '';
        while (! $stream->eof() && strlen($body) <= config('routing.max_response_bytes')) {
            $chunk = $stream->read(min(65536, config('routing.max_response_bytes') + 1 - strlen($body)));
            if ($chunk === '' && ! $stream->eof()) {
                throw new \RuntimeException('Incomplete router response');
            }
            $body .= $chunk;
        }
        $stream->close();
        if (strlen($body) > config('routing.max_response_bytes')) {
            return ['status' => 'UNKNOWN', 'reason' => 'Ответ маршрутизатора превышает ограничение пилота. Выберите более близкие точки.'];
        }
        $data = json_decode($body, true, flags: JSON_THROW_ON_ERROR);
        if (($data['code'] ?? '') === 'NoSegment') {
            return ['status' => 'NEEDS_REFINEMENT', 'reason' => 'Выбранную дорожную точку не удалось сопоставить с автомобильным графом. Уточните старт и место на доступной улице.', 'checks' => ['SNAP_NO_SAFE_CANDIDATE'],
                'diagnostic_issues' => [TripDiagnostics::issue('ROUTER_NO_SEGMENT', 'unknown', 'routing')]];
        }
        if (($data['code'] ?? '') === 'NoRoute') {
            return ['status' => 'NO_PATH', 'reason' => 'В локальном графе не найден автомобильный путь между этими точками. Это не доказывает невозможность поездки в реальности.',
                'diagnostic_issues' => [TripDiagnostics::issue('NO_ROUTE', 'route', 'routing')]];
        }
        $route = $data['routes'][0] ?? null;
        $line = $route['geometry'] ?? null;
        $points = $line['coordinates'] ?? [];
        if ($response->status() !== 200 || ($data['code'] ?? '') !== 'Ok' || ($line['type'] ?? '') !== 'LineString' || count($points) < 2 || count($points) > 10_000) {
            return ['status' => 'UNKNOWN', 'reason' => 'Маршрутизатор не вернул проверяемую полную линию.'];
        }
        foreach ($points as $point) {
            if (! is_array($point) || count($point) !== 2 || ! $this->number($point[0] ?? null) || ! $this->number($point[1] ?? null) || abs($point[0]) > 180 || abs($point[1]) > 90) {
                return ['status' => 'UNKNOWN', 'reason' => 'Геометрия ответа не прошла проверку.'];
            }
            if (! $this->snapshot->contains(['lon' => $point[0], 'lat' => $point[1]])) {
                return ['status' => 'OUTSIDE_PILOT', 'reason' => 'Часть линии выходит за подтверждённую территорию пилота.',
                    'diagnostic_issues' => [TripDiagnostics::issue('OUTSIDE_CONFIRMED_COVERAGE', 'route', 'geometry')]];
            }
        }
        $distance = $route['distance'] ?? null;
        $duration = $route['duration'] ?? null;
        if (! $this->number($distance) || ! $this->number($duration) || $distance < 0 || $duration < 0 || ($distance > 1 && $duration <= 0) || $distance > config('routing.max_route_distance_m')) {
            return ['status' => 'UNKNOWN', 'reason' => 'Длина или время выходят за проверенные ограничения пилота.'];
        }
        $actualStart = ['lon' => $points[0][0], 'lat' => $points[0][1]];
        $last = $points[array_key_last($points)];
        $actualTarget = ['lon' => $last[0], 'lat' => $last[1]];
        $mismatches = [];
        foreach (['start' => [$a, $actualStart], 'target' => [$b, $actualTarget]] as $end => [$selected, $actual]) {
            if ($this->distance($selected, $actual) > RoutingGeometryGuard::SOURCE_TOLERANCE_M) {
                $mismatches[] = TripDiagnostics::issue('ROUTER_ENDPOINT_MISMATCH', $end, 'geometry');
            }
        }
        if ($mismatches) {
            return ['status' => 'NEEDS_REFINEMENT', 'reason' => 'Маршрутизатор выбрал другую дорожную точку. Уточните положение на карте.', 'diagnostic_issues' => $mismatches];
        }
        $snaps = ['start' => ['original' => $start, 'matched' => $actualStart, 'distance_m' => $this->distance($start, $actualStart)],
            'target' => ['original' => $target, 'matched' => $actualTarget, 'distance_m' => $this->distance($target, $actualTarget)]];
        if (max($snaps['start']['distance_m'], $snaps['target']['distance_m']) > $manifest['snap_limit_m']) {
            $details = [];
            foreach ($snaps as $end => $snap) {
                if ($snap['distance_m'] > $manifest['snap_limit_m']) {
                    $details[] = TripDiagnostics::issue('SNAP_LIMIT_EXCEEDED', $end, 'geometry');
                }
            }

            return ['status' => 'NEEDS_REFINEMENT', 'snaps' => $snaps, 'reason' => 'Фактическое начало или конец линии дальше 35 м от исходной точки. Уточните точку на доступной улице.', 'diagnostic_issues' => $details];
        }
        if ($distance < .01 && ($this->distance($start, $target) > .1 || max($snaps['start']['distance_m'], $snaps['target']['distance_m']) > .1)) {
            return ['status' => 'NEEDS_REFINEMENT', 'snaps' => $snaps, 'reason' => 'Нулевая линия получилась после привязки разных точек к одному месту. Уточните точки; нулевое время не подтверждено.'];
        }
        $nodes = $route['legs'][0]['annotation']['nodes'] ?? null;
        if (! is_array($nodes) || count($nodes) > 30_000 || ($distance > 1 && count($nodes) < 2) || array_filter($nodes, fn ($n) => ! is_int($n) || $n <= 0)) {
            return ['status' => 'UNKNOWN', 'snaps' => $snaps, 'reason' => 'Происхождение рёбер пути не удалось проверить.'];
        }
        $review = $this->guard->review($this->snapshot, $line, $start, $target, $nodes);
        if ($review['status'] !== 'AVAILABLE') {
            return $review + ['snaps' => $snaps];
        }
        if (isset($review['geometry_distance_m']) && abs($distance - $review['geometry_distance_m']) > max(5, $distance * .02)) {
            return ['status' => 'UNKNOWN', 'snaps' => $snaps, 'reason' => 'Сообщённая длина не согласуется с полной геометрией. Расчёт не принят.'];
        }
        unset($review['geometry_distance_m']);

        return $review + ['snaps' => $snaps, 'route' => ['geometry' => $line, 'distance_m' => $distance, 'duration_s' => $duration]];
    }

    private function metric(string $key, ?float $value, string $unit, array $row, ?array $source, string $at): array
    {
        return ['key' => $key, 'value' => $value, 'unit' => $unit, 'source' => 'OpenStreetMap / OSRM car',
            'dataset_import_id' => null, 'dataset_version' => $source['dataset_version'] ?? null,
            'observed_at' => $source['observed_at'] ?? null, 'calculated_at' => $at,
            'quality' => ['method' => $value === null ? null : 'DERIVED',
                'availability' => $value !== null ? 'AVAILABLE' : (in_array($row['status'], ['UNAVAILABLE', 'OUTSIDE_PILOT'], true) ? 'UNAVAILABLE' : 'INSUFFICIENT_DATA'),
                'freshness' => 'UNKNOWN', 'reason' => $row['reason']]];
    }

    private function point(array $value): array
    {
        return ['lon' => (float) $value['lon'], 'lat' => (float) $value['lat']];
    }

    private function number(mixed $value): bool
    {
        return (is_int($value) || is_float($value)) && is_finite((float) $value);
    }

    private function distance(array $a, array $b): float
    {
        $lat1 = deg2rad($a['lat']);
        $lat2 = deg2rad($b['lat']);
        $h = sin(($lat2 - $lat1) / 2) ** 2 + cos($lat1) * cos($lat2) * sin(deg2rad($b['lon'] - $a['lon']) / 2) ** 2;

        return 12_742_017.6 * asin(min(1, sqrt($h)));
    }
}
