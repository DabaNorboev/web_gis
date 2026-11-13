<?php

namespace App\Services\Analysis;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Log;
use Throwable;

/** Independent snapshot transactions: a category failure preserves other local results. */
class RetailPoiProvider
{
    public function __construct(private GroceryPoiProvider $grocery, private PharmacyPoiProvider $pharmacy, private OfficialStopPoiProvider $officialStops, private ParkPoiProvider $parks) {}

    public function analyze(array $point, int $radius): array
    {
        $coverage = $completeness = $availability = $items = [];
        $counts = array_fill_keys(['grocery', 'pharmacy', 'official_stop', 'park'], null);
        $providers = ['grocery' => $this->grocery, 'pharmacy' => $this->pharmacy, 'official_stop' => $this->officialStops, 'park' => $this->parks];
        $stopSummary = ['found_count' => null, 'source_without_coordinates' => null];
        $ready = $failed = false;
        foreach ($counts as $category => $_) {
            $reason = 'Provider категории '.$category.' ещё не подключён (А8).';
            $availability[$category] = ['status' => 'UNAVAILABLE', 'code' => 'CATEGORY_PROVIDER_UNAVAILABLE', 'message' => $reason];
            $coverage[$category] = ['status' => 'UNKNOWN', 'reason' => $reason, 'available_radius_m' => null];
            $completeness[$category] = ['status' => 'UNKNOWN', 'reason' => $reason];
            if (! isset($providers[$category])) {
                continue;
            }
            try {
                $block = $providers[$category]->analyze($point, $radius);
                $coverage[$category] = $block['coverage']['by_category'][$category];
                $completeness[$category] = $block['completeness']['by_category'][$category];
                $availability[$category] = ['status' => $block['status'], 'code' => $block['code'], 'message' => $coverage[$category]['reason']];
                if ($block['status'] === 'READY') {
                    $ready = true;
                    if ($category === 'official_stop') {
                        $stopSummary = $block['data']['official_stop_summary'];
                    }
                    array_push($items, ...$block['data']['items']);
                    $counts[$category] = $block['data']['counts_by_category'][$category];
                }
            } catch (Throwable $error) {
                $failed = true;
                $reason = 'Не удалось рассчитать категорию '.$category.'.';
                Log::error('Place analysis category failed.', ['category' => $category, 'exception_type' => get_class($error)]);
                $availability[$category] = ['status' => 'ERROR', 'code' => 'CATEGORY_CALCULATION_FAILED', 'message' => $reason];
                $coverage[$category]['reason'] = $completeness[$category]['reason'] = $reason;
            }
        }
        // The same OSM object can carry both tags. Keep one identity, with the
        // explicit pharmacy tag taking precedence; never merge different IDs.
        $byId = [];
        foreach ($items as $item) {
            if (! isset($byId[$item['id']]) || $item['category'] === 'pharmacy') {
                $byId[$item['id']] = $item;
            }
        }
        $items = array_values($byId);
        foreach (['grocery', 'pharmacy', 'park'] as $category) {
            if ($counts[$category] !== null) {
                $counts[$category] = count(array_filter($items, fn ($item) => $item['category'] === $category));
            }
        }
        usort($items, fn ($a, $b) => ($a['distance_m'] <=> $b['distance_m']) ?: strcmp($a['id'], $b['id']) ?: strcmp($a['category'], $b['category']));
        $statuses = array_column($coverage, 'status');
        $summary = count(array_unique($statuses)) === 1 && $statuses[0] === 'OUTSIDE_SERVICE_AREA' ? 'OUTSIDE_SERVICE_AREA'
            : (in_array('PARTIAL', $statuses, true) || in_array('OUTSIDE_SERVICE_AREA', $statuses, true) ? 'PARTIAL'
                : (in_array('UNKNOWN', $statuses, true) ? 'UNKNOWN' : 'COVERED'));
        $total = ! in_array(null, $counts, true) ? count($items) : null;

        return ['status' => $ready ? 'READY' : ($failed ? 'ERROR' : 'UNAVAILABLE'),
            'code' => $ready ? null : ($failed ? 'BLOCK_CALCULATION_FAILED' : 'POI_SNAPSHOTS_UNAVAILABLE'),
            'message' => $ready ? 'Категории рассчитаны независимо; доступность и покрытие указаны отдельно. Расстояния прямые, не пешая доступность.' : 'Нет доступных результатов POI.',
            'calculated_at' => CarbonImmutable::now('UTC')->toISOString(),
            'method_version' => config('place_analysis.parks_enabled') ? 'poi-v3-geography-source-geometry-park-outer-aliases' : (config('place_analysis.official_stops_enabled') ? 'poi-v2-geography-source-geometry-independent-categories' : 'osm-retail-v1-geography-source-geometry-independent-categories'),
            'availability_by_category' => $availability,
            'coverage' => ['status' => $summary, 'reason' => 'Покрытие определяется отдельно по категориям.', 'available_radius_m' => null, 'by_category' => $coverage],
            'completeness' => ['status' => in_array('PARTIAL', array_column($completeness, 'status'), true) ? 'PARTIAL' : 'UNKNOWN', 'reason' => 'Полнота источников относительно реального мира неизвестна.', 'by_category' => $completeness],
            'data' => $ready ? ['official_stop_summary' => $stopSummary, 'items' => $items, 'count' => $total, 'counts_by_category' => $counts] : null];
    }
}
