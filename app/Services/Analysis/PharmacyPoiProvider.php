<?php

namespace App\Services\Analysis;

use App\Services\Osm\Import\OsmPharmacyReader;

class PharmacyPoiProvider extends GroceryPoiProvider
{
    protected const DATASET = 'pharmacy';

    protected const METHOD = OsmPharmacyReader::METHOD;
}
