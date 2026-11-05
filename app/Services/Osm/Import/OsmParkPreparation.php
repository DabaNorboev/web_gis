<?php

namespace App\Services\Osm\Import;

class OsmParkPreparation extends OsmGroceryPreparation
{
    protected const DATASET = 'park';

    protected const TAG = 'leisure';

    protected const VALUES = OsmParkReader::SHOPS;

    public function validate(array $document, array $coverage): void
    {
        if (! is_string($document['preparation']['retail_script_sha256'] ?? null)
            || ! preg_match('/^[0-9a-f]{64}$/D', $document['preparation']['retail_script_sha256'])) {
            throw new \RuntimeException('Missing park shared pipeline provenance.');
        }
        parent::validate($document, $coverage);
    }
}
