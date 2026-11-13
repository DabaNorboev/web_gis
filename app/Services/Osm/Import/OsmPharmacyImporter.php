<?php

namespace App\Services\Osm\Import;

use App\Services\Gis\DatasetCoverage;

class OsmPharmacyImporter extends OsmGroceryImporter
{
    public function __construct(OsmPharmacyReader $reader, DatasetCoverage $coverage, OsmPharmacyPreparation $preparation)
    {
        parent::__construct($reader, $coverage, $preparation);
    }
}
