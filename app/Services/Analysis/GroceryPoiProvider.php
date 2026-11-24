<?php

namespace App\Services\Analysis;

class GroceryPoiProvider extends OsmPoiProvider
{
    protected const DATASET = 'grocery';

    protected const COMPLETENESS_REASON = 'Полнота OSM и фактическая работа магазинов не подтверждены.';

    protected const POSSIBLE_DUPLICATE_NOTE = 'Возможное повторное представление магазина в OSM; общая идентичность не подтверждена, автоматического слияния нет.';
}
