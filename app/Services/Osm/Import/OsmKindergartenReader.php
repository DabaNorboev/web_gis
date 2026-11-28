<?php

namespace App\Services\Osm\Import;

class OsmKindergartenReader extends OsmGroceryReader
{
    public const DATASET = 'kindergarten';

    public const TAG = 'amenity';

    public const SHOPS = ['kindergarten'];

    public const METHOD = 'osm-kindergarten-v1-source-geometry';
}
