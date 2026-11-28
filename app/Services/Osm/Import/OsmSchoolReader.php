<?php

namespace App\Services\Osm\Import;

class OsmSchoolReader extends OsmGroceryReader
{
    public const DATASET = 'school';

    public const TAG = 'amenity';

    public const SHOPS = ['school'];

    public const METHOD = 'osm-school-v1-source-geometry';
}
