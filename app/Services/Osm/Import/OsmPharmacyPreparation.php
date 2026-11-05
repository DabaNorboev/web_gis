<?php

namespace App\Services\Osm\Import;

class OsmPharmacyPreparation extends OsmGroceryPreparation
{
    protected const DATASET = 'pharmacy';

    protected const TAG = 'amenity';

    protected const VALUES = OsmPharmacyReader::SHOPS;

    public function validate(array $document, array $coverage): void
    {
        if (! is_string($document['preparation']['retail_script_sha256'] ?? null)
            || ! preg_match('/^[0-9a-f]{64}$/D', $document['preparation']['retail_script_sha256'])) {
            throw new \RuntimeException('Missing pharmacy shared pipeline provenance.');
        }
        parent::validate($document, $coverage);
    }
}
