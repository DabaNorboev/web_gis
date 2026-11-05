<?php

namespace App\Services\Osm\Import;

class OsmPharmacyReader extends OsmGroceryReader
{
    public const DATASET = 'pharmacy';

    public const TAG = 'amenity';

    public const SHOPS = ['pharmacy'];

    public const METHOD = 'osm-pharmacy-v1-geography-source-geometry-identity-and-equivalent-member';

    protected function excluded(array $tags): bool
    {
        return in_array($tags['access'] ?? null, ['private', 'no'], true);
    }

    protected function lifecycleFlags(string $key): array
    {
        return [$key, $key.':amenity', $key.':healthcare', $key.':shop'];
    }
}
