<?php

namespace App\Services\Osm\Import;

use DateTimeImmutable;
use RuntimeException;

/** Shared snapshot identity and timestamp validation; no address filtering. */
class OsmSnapshotReader
{
    public function read(string $contents): array
    {
        $document = json_decode($contents, true, flags: JSON_THROW_ON_ERROR);
        if (! is_array($document) || ! isset($document['elements']) || ! is_array($document['elements']) || ! array_is_list($document['elements'])) {
            throw new RuntimeException('Expected an Overpass JSON document with an elements list.');
        }
        if (isset($document['remark'])) {
            throw new RuntimeException('Overpass reported an incomplete/error response: '.$document['remark']);
        }
        $seen = [];
        foreach ($document['elements'] as $element) {
            if (! is_array($element) || ! in_array($element['type'] ?? null, ['node', 'way', 'relation'], true)
                || ! is_int($element['id'] ?? null) || $element['id'] <= 0) {
                throw new RuntimeException('Invalid OSM object identity.');
            }
            $key = $element['type'].'/'.$element['id'];
            if (isset($seen[$key])) {
                throw new RuntimeException('Duplicate OSM object: '.$key);
            }
            $seen[$key] = true;
        }
        $this->timestamp($document['osm3s']['timestamp_osm_base'] ?? null);

        return $document;
    }

    public function timestamp(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }
        $date = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s\Z', $value, new \DateTimeZone('UTC'));
        if (! $date || $date->format('Y-m-d\TH:i:s\Z') !== $value) {
            throw new RejectedAddress('Invalid OSM timestamp: '.$value);
        }

        return $value;
    }
}
