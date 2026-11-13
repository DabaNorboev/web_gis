<?php

namespace App\Services\Analysis;

use App\Services\Osm\Import\OsmParkReader;

class ParkPoiProvider extends GroceryPoiProvider
{
    protected const DATASET = 'park';

    protected const METHOD = OsmParkReader::METHOD;

    public function analyze(array $point, int $radius): array
    {
        if (! config('place_analysis.parks_enabled')) {
            $reason = 'Подключение парков к анализу места ожидает отдельной активации.';

            return ['status' => 'UNAVAILABLE', 'code' => 'PARK_NOT_ENABLED', 'data' => null,
                'coverage' => ['by_category' => ['park' => ['status' => 'UNKNOWN', 'reason' => $reason, 'available_radius_m' => null]]],
                'completeness' => ['by_category' => ['park' => ['status' => 'UNKNOWN', 'reason' => $reason]]]];
        }
        $block = parent::analyze($point, $radius);
        if ($block['status'] === 'READY') {
            $block['completeness']['by_category']['park']['reason'] = 'Полнота OSM, общественный доступ, вход и возможность прогулки не подтверждены.';
            foreach ($block['data']['items'] as &$item) {
                $item['identity_note'] = $item['identity_note'] === null ? null : 'Возможное повторное представление парка в OSM; общая идентичность не подтверждена, автоматического слияния нет.';
                $item['source_version'] = $item['source_updated_at'];
                $item['source_url'] = 'https://www.openstreetmap.org/copyright';
                $item['limitations'] = $item['geometry']['type'] === 'Point'
                    ? 'Отметка парка: границы неизвестны. Расстояние до отметки; территория, вход и доступ не подтверждены.'
                    : 'Расстояние до ближайшей части территории, не до входа. Публичный доступ, известный вход и возможность прогулки не подтверждены.';
            }
            unset($item);
        }

        return $block;
    }
}
