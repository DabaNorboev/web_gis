<?php

namespace App\Services\Analysis;

class ParkPoiProvider extends OsmPoiProvider
{
    protected const DATASET = 'park';

    protected const COMPLETENESS_REASON = 'Полнота OSM, общественный доступ, вход и возможность прогулки не подтверждены.';

    protected const POSSIBLE_DUPLICATE_NOTE = 'Возможное повторное представление парка в OSM; общая идентичность не подтверждена, автоматического слияния нет.';

    public function analyze(array $point, int $radius): PoiCategoryResult
    {
        if (! config('place_analysis.parks_enabled')) {
            return PoiCategoryResult::unavailable('PARK_NOT_ENABLED', 'Подключение парков к анализу места ожидает отдельной активации.');
        }

        return parent::analyze($point, $radius);
    }

    protected function itemMetadata(array $item): array
    {
        return [
            'source_version' => $item['source_updated_at'],
            'source_url' => 'https://www.openstreetmap.org/copyright',
            'limitations' => $item['geometry']['type'] === 'Point'
                ? 'Отметка парка: границы неизвестны. Расстояние до отметки; территория, вход и доступ не подтверждены.'
                : 'Расстояние до ближайшей части территории, не до входа. Публичный доступ, известный вход и возможность прогулки не подтверждены.',
        ];
    }
}
