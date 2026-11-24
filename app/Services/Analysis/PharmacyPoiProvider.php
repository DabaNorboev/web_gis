<?php

namespace App\Services\Analysis;

class PharmacyPoiProvider extends OsmPoiProvider
{
    protected const DATASET = 'pharmacy';

    protected const COMPLETENESS_REASON = 'Полнота OSM и фактическая работа аптек не подтверждены.';

    protected const POSSIBLE_DUPLICATE_NOTE = 'Возможное повторное представление аптеки в OSM. Общая идентичность не подтверждена, записи сохранены отдельно.';
}
