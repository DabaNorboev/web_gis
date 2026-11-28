<?php

namespace App\Services\Osm\Import;

class OsmKindergartenPreparation extends OsmGroceryPreparation
{
    protected const DATASET = OsmKindergartenReader::DATASET;

    protected const TAG = OsmKindergartenReader::TAG;

    protected const VALUES = OsmKindergartenReader::SHOPS;
}
