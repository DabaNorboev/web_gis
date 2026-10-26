<?php

namespace App\Services\Routing;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Throwable;

/** Static walking estimates between explicitly supplied street points only. */
class LocalWalkingRouterProvider
{
    private const LIMITATION = 'Путь относится только к выбранным уличным точкам. Подход от объекта, вход и реальная проходимость не подтверждены. Время — статическая модель прогулки.';

    public function __construct(private WalkingRoutingSnapshot $snapshot, private WalkingGeometryGuard $guard) {}

    public function analyze(array $start, array $places): array
    {
        $originalStart = $this->point($start);
        $streetStart = $this->point($start['road'] ?? $start);
        $source = null;
        try {
            $m = $this->snapshot->manifest();
            $source = ['name' => 'OpenStreetMap', 'engine' => 'ORS', 'engine_version' => $m['engine_version'],
                'profile' => 'foot-walking', 'dataset_version' => $m['version'],
                'pbf_sha256' => $m['pbf_sha256'], 'extract_sha256' => $m['extract_sha256'],
                'manifest_sha256' => config('routing.walking.manifest_sha256'), 'observed_at' => $m['observed_at'],
                'prepared_at' => $m['prepared_at'], 'guard_imports' => $m['guard_sources']['imports'],
                'pilot_bbox' => $m['bbox'], 'route_scope' => 'street_points'];
        } catch (Throwable) {
            // Never substitute another provider or a mutable snapshot.
        }
        $results = [];
        $validated = [];
        foreach ($places as $index => $place) {
            $target = $this->point($place);
            $streetTarget = $this->point($place['road'] ?? $place);
            $row = ['index' => $index, 'label' => trim($place['label'] ?? '') ?: 'Место '.($index + 1),
                'start' => $originalStart, 'target' => $target, 'route_scope' => 'street_points',
                'street_points' => ['start' => $streetStart, 'target' => $streetTarget],
                'selection_kind' => max($this->distance($originalStart, $streetStart), $this->distance($target, $streetTarget)) > 20
                    ? 'DIFFERENT_STREET_POINTS' : ((isset($start['road']) || isset($place['road'])) ? 'EXPLICIT_STREET_POINTS' : 'INPUT_STREET_POINTS'),
                'approaches' => ['start' => $this->approach($originalStart, $streetStart, isset($start['road'])),
                    'target' => $this->approach($target, $streetTarget, isset($place['road']))],
                'status' => 'UNAVAILABLE', 'reason' => 'Пеший снимок не подготовлен или изменился.',
                'route' => null, 'snaps' => null, 'road_choices' => null, 'checks' => ['WALKING_DATA_UNAVAILABLE']];
            if ($source !== null) {
                try {
                    $row = array_replace($row, $this->pair($originalStart, $target, $streetStart, $streetTarget, $validated));
                } catch (ConnectionException) {
                    $row = array_replace($row, ['status' => 'UNAVAILABLE', 'reason' => 'Локальный пеший маршрутизатор недоступен.', 'checks' => ['ROUTER_UNAVAILABLE']]);
                } catch (Throwable) {
                    $row = array_replace($row, ['status' => 'UNKNOWN', 'reason' => 'Проверить пеший путь не удалось. Уточните уличные точки или повторите расчёт.', 'checks' => ['ROUTE_CHECK_FAILED']]);
                }
            }
            if ($row['status'] !== 'AVAILABLE') {
                $row['route'] = null;
                $row['snaps'] = null;
            }
            $issues = $row['diagnostic_issues'] ?? array_map(fn ($code) => TripDiagnostics::issue($code), $row['checks']);
            if (! $issues && $row['status'] !== 'AVAILABLE') {
                $issues = [TripDiagnostics::issue('ROUTE_NOT_CONFIRMED')];
            }
            $row['diagnostics'] = TripDiagnostics::envelope($issues, $index);
            unset($row['diagnostic_issues']);
            $at = now('UTC')->toIso8601String();
            $row['metrics'] = [
                'distance' => $this->metric('route_distance', $row['route']['distance_m'] ?? null, 'm', $row['reason'], $source, $at, status: $row['status']),
                'duration' => $this->metric('route_duration', $row['route']['duration_s'] ?? null, 's', $row['reason'], $source, $at, status: $row['status']),
            ];
            $row['address_metrics'] = [
                'distance' => $this->metric('object_to_object_distance', null, 'm', 'Подходы к объектам не подтверждены.', $source, $at, 'objects'),
                'duration' => $this->metric('object_to_object_duration', null, 's', 'Подходы к объектам не подтверждены.', $source, $at, 'objects'),
            ];
            $results[] = $row;
        }

        return ['mode' => 'walking', 'route_scope' => 'street_points', 'start' => $originalStart,
            'results' => $results, 'source' => $source, 'limitation' => self::LIMITATION];
    }

    private function pair(array $originalStart, array $originalTarget, array $start, array $target, array &$validated): array
    {
        $outside = [];
        foreach (['start' => $start, 'target' => $target] as $end => $point) {
            if (! $this->snapshot->contains($point) || ! $this->guard->scope($this->snapshot, $point)) {
                $outside[] = TripDiagnostics::issue('OUTSIDE_CONFIRMED_COVERAGE', $end, 'scope');
            }
        }
        if ($outside) {
            return ['status' => 'OUTSIDE_PILOT', 'reason' => 'Выбранная улица вне подтверждённой территории пешего пилота.',
                'checks' => ['OUTSIDE_CONFIRMED_COVERAGE'], 'diagnostic_issues' => $outside];
        }
        $choices = [];
        foreach (['start' => $start, 'target' => $target] as $end => $point) {
            $key = json_encode($point);
            $choices[$end] = $validated[$key] ??= $this->guard->validatePoint($this->snapshot, $point);
        }
        $issues = [];
        foreach ($choices as $end => $choice) {
            if ($choice['status'] !== 'SELECTED') {
                $codes = $choice['checks'] ?? [match ($choice['status']) {
                    'CHOOSE' => 'SNAP_CHOICE_REQUIRED', 'OUTSIDE_PILOT' => 'OUTSIDE_CONFIRMED_COVERAGE',
                    'UNKNOWN' => 'SNAP_CHECK_FAILED', default => 'SNAP_NO_SAFE_CANDIDATE',
                }];
                foreach ($codes as $code) {
                    $issues[] = TripDiagnostics::issue($code, $end, 'snap');
                }
            }
        }
        if ($issues) {
            return ['status' => in_array('UNKNOWN', array_column($choices, 'status'), true) ? 'UNKNOWN' : 'NEEDS_REFINEMENT',
                'reason' => 'Выберите однозначную уличную точку вне здания и известных препятствий. Объект не переносится автоматически.',
                'road_choices' => $choices, 'checks' => array_values(array_unique(array_column($issues, 'code'))), 'diagnostic_issues' => $issues];
        }

        return $this->route($start, $target) + ['road_choices' => $choices];
    }

    private function route(array $start, array $target): array
    {
        $began = microtime(true);
        $maximum = config('routing.walking.max_response_bytes');
        $response = Http::connectTimeout(config('routing.walking.connect_timeout_s'))->timeout(config('routing.walking.timeout_s'))
            ->withHeaders(['Accept-Encoding' => 'identity', 'Cache-Control' => 'no-store'])
            ->withOptions(['allow_redirects' => false, 'decode_content' => false,
                'progress' => function ($total, $downloaded) use ($began, $maximum) {
                    if ($total > $maximum || $downloaded > $maximum || microtime(true) - $began > config('routing.walking.timeout_s')) {
                        throw new \RuntimeException('Walking response budget exceeded');
                    }
                }])
            ->post(config('routing.walking.url').'/directions/foot-walking/geojson', [
                'coordinates' => [[$start['lon'], $start['lat']], [$target['lon'], $target['lat']]],
                'radiuses' => [20, 20], 'geometry_simplify' => false, 'instructions' => false, 'extra_info' => ['osmid', 'waytype'],
            ]);
        if ($response->redirect() || $response->status() >= 500) {
            return ['status' => 'UNAVAILABLE', 'reason' => 'Локальный пеший маршрутизатор недоступен.', 'checks' => ['ROUTER_UNAVAILABLE']];
        }
        $stream = $response->toPsrResponse()->getBody();
        $raw = '';
        try {
            while (! $stream->eof() && strlen($raw) <= $maximum) {
                $chunk = $stream->read(min(65536, $maximum + 1 - strlen($raw)));
                if ($chunk === '' && ! $stream->eof()) {
                    throw new \RuntimeException('Incomplete walking response');
                }
                $raw .= $chunk;
            }
        } finally {
            $stream->close();
        }
        if (strlen($raw) > $maximum) {
            return ['status' => 'UNKNOWN', 'reason' => 'Ответ пешего маршрутизатора превышает бюджет пилота.', 'checks' => ['ROUTE_CHECK_FAILED']];
        }
        $body = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
        if (! is_array($body)) {
            return ['status' => 'UNKNOWN', 'reason' => 'Некорректный ответ пешего маршрутизатора.', 'checks' => ['ROUTE_CHECK_FAILED']];
        }
        $code = $body['error']['code'] ?? null;
        if ($code === 2010) {
            return ['status' => 'NEEDS_REFINEMENT', 'reason' => 'Пеший граф не сопоставил выбранную улицу в пределах 20 м.', 'checks' => ['ROUTER_NO_SEGMENT']];
        }
        if ($code === 2009) {
            return ['status' => 'NO_PATH', 'reason' => 'В статическом пешем графе путь не найден. Реальная невозможность прохода не установлена.', 'checks' => ['NO_ROUTE']];
        }
        if ($response->status() !== 200) {
            return ['status' => 'UNKNOWN', 'reason' => 'Пеший маршрутизатор не вернул проверяемый путь.', 'checks' => ['ROUTE_CHECK_FAILED']];
        }
        $measures = $body['features'][0]['properties']['summary'] ?? [];
        foreach (['distance', 'duration'] as $key) {
            if (! $this->number($measures[$key] ?? null) || $measures[$key] < 0) {
                return ['status' => 'UNKNOWN', 'reason' => 'Некорректные меры пешего пути.', 'checks' => ['ROUTE_CHECK_FAILED']];
            }
        }
        if ($measures['distance'] > config('routing.walking.max_route_distance_m')
            || ($measures['distance'] > 0 && $measures['duration'] <= 0)
            || ($measures['distance'] < .01 && $this->distance($start, $target) > .1)) {
            return ['status' => 'UNKNOWN', 'reason' => 'Меры пешего пути выходят за ограничения пилота.', 'checks' => ['ROUTE_CHECK_FAILED']];
        }
        $review = $this->guard->review($this->snapshot, $body, $start, $target);
        if (($review['status'] ?? null) !== 'AVAILABLE') {
            return $review;
        }
        $line = $review['geometry'] ?? null;
        $distance = $review['distance_m'] ?? null;
        $duration = $review['duration_s'] ?? null;
        if (($line['type'] ?? null) !== 'LineString' || count($line['coordinates'] ?? []) < 2
            || ! $this->number($distance) || ! $this->number($duration) || $distance < 0 || $duration < 0
            || $distance > config('routing.walking.max_route_distance_m') || ($distance > 0 && $duration <= 0)) {
            return ['status' => 'UNKNOWN', 'reason' => 'Не удалось получить проверенную исходную линию пешего пути.', 'checks' => ['ROUTE_CHECK_FAILED']];
        }
        $points = $line['coordinates'];
        $a = ['lon' => $points[0][0], 'lat' => $points[0][1]];
        $last = $points[array_key_last($points)];
        $b = ['lon' => $last[0], 'lat' => $last[1]];

        return ['status' => 'AVAILABLE', 'reason' => 'Дорожная часть прошла проверки сохранённой модели. '.self::LIMITATION,
            'checks' => [], 'route' => ['scope' => 'street_points', 'geometry' => $line, 'distance_m' => $distance, 'duration_s' => $duration],
            'snaps' => ['start' => ['original' => $start, 'matched' => $a, 'distance_m' => $this->distance($start, $a)],
                'target' => ['original' => $target, 'matched' => $b, 'distance_m' => $this->distance($target, $b)]]];
    }

    private function approach(array $original, array $street, bool $separateObject): array
    {
        return ['status' => $separateObject ? 'UNKNOWN' : 'NOT_INCLUDED', 'distance_m' => null, 'duration_s' => null,
            'original' => $original, 'selected_street' => $street, 'selection_shift_m' => $this->distance($original, $street),
            'reason' => 'Связь объекта с улицей и вход не подтверждены; смещение не является рассчитанным подходом.'];
    }

    private function metric(string $key, ?float $value, string $unit, string $reason, ?array $source, string $at, string $scope = 'street_points', string $status = 'UNKNOWN'): array
    {
        return ['key' => $key, 'value' => $value, 'unit' => $unit, 'scope' => $scope, 'source' => 'OpenStreetMap / ORS foot-walking',
            'dataset_import_id' => null, 'dataset_version' => $source['dataset_version'] ?? null,
            'observed_at' => $source['observed_at'] ?? null, 'calculated_at' => $at,
            'quality' => ['method' => $value === null ? null : 'DERIVED', 'availability' => $value !== null ? 'AVAILABLE'
                : (in_array($status, ['UNAVAILABLE', 'OUTSIDE_PILOT'], true) ? 'UNAVAILABLE' : 'INSUFFICIENT_DATA'),
                'freshness' => 'UNKNOWN', 'reason' => $reason]];
    }

    private function point(array $point): array
    {
        return ['lon' => (float) $point['lon'], 'lat' => (float) $point['lat']];
    }

    private function number(mixed $value): bool
    {
        return (is_float($value) || is_int($value)) && is_finite((float) $value);
    }

    private function distance(array $a, array $b): float
    {
        $lat1 = deg2rad($a['lat']);
        $lat2 = deg2rad($b['lat']);
        $h = sin(($lat2 - $lat1) / 2) ** 2 + cos($lat1) * cos($lat2) * sin(deg2rad($b['lon'] - $a['lon']) / 2) ** 2;

        return 12_742_017.6 * asin(min(1, sqrt($h)));
    }
}
