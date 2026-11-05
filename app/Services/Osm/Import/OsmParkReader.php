<?php

namespace App\Services\Osm\Import;

class OsmParkReader extends OsmGroceryReader
{
    public const DATASET = 'park';

    public const TAG = 'leisure';

    public const SHOPS = ['park'];

    public const METHOD = 'osm-park-v1-source-geometry-explicit-outer-aliases';

    protected function excluded(array $tags): bool
    {
        return ($tags['landuse'] ?? null) === 'cemetery' || ($tags['amenity'] ?? null) === 'grave_yard';
    }
}
