<?php

namespace App\Services\Analysis;

class KindergartenPoiProvider extends OsmPoiProvider
{
    protected const DATASET = 'kindergarten';

    protected const COMPLETENESS_REASON = 'Полнота OSM и актуальность учреждений не подтверждены.';

    protected const POSSIBLE_DUPLICATE_NOTE = 'Возможное повторное представление учреждения в OSM.';

    protected function itemMetadata(array $item): array
    {
        return ['source_url' => 'https://www.openstreetmap.org/copyright'];
    }
}
