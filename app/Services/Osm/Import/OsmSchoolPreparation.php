<?php

namespace App\Services\Osm\Import;

class OsmSchoolPreparation extends OsmGroceryPreparation
{
    protected const DATASET = OsmSchoolReader::DATASET;

    protected const TAG = OsmSchoolReader::TAG;

    protected const VALUES = OsmSchoolReader::SHOPS;
}
