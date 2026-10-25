<?php

namespace App\Services\Osm\Import;

use Generator;

class OsmAddressReader
{
    public function __construct(private OsmAddressGeometry $geometry, private OsmSnapshotReader $snapshot) {}

    public function read(string $contents): array
    {
        return $this->snapshot->read($contents);
    }

    public function timestamp(?string $value): ?string
    {
        return $this->snapshot->timestamp($value);
    }

    public function candidates(array $document): Generator
    {
        $membership = [];
        foreach ($document['elements'] as $element) {
            if ($element['type'] !== 'relation' || ($element['tags']['type'] ?? null) !== 'associatedStreet') {
                continue;
            }
            foreach ($element['members'] ?? [] as $member) {
                if (in_array($member['role'] ?? '', ['house', 'address', 'addr:houselink'], true)) {
                    $membership[$member['type'].'/'.$member['ref']][] = ['id' => $element['id'], 'name' => trim($element['tags']['name'] ?? '')];
                }
            }
        }
        foreach ($document['elements'] as $element) {
            $key = $element['type'].'/'.$element['id'];
            if ($element['type'] === 'relation' && ($element['tags']['type'] ?? null) === 'associatedStreet') {
                yield ['source_id' => $key, 'skip' => 'auxiliary_relation'];

                continue;
            }
            try {
                $tags = $element['tags'] ?? [];
                $text = function ($key) use ($tags) {
                    $value = isset($tags[$key]) && is_string($tags[$key]) ? trim($tags[$key]) : '';

                    return $value === '' ? null : $value;
                };
                $house = $text('addr:housenumber');
                $street = $text('addr:street');
                $place = $text('addr:place');
                $relations = $membership[$key] ?? [];
                $names = array_values(array_unique(array_column($relations, 'name')));
                $method = $street ? 'addr:street' : ($place ? 'addr:place' : null);
                if (! $street && ! $place && count($names) === 1 && $names[0] !== '') {
                    $street = $names[0];
                    $method = 'associatedStreet';
                }
                if ($house === null || ($street === null && $place === null)) {
                    throw new RejectedAddress(count($names) > 1 ? 'ambiguous_associated_street' : 'missing_address_parts');
                }
                if (isset($element['version']) && (! is_int($element['version']) || $element['version'] <= 0)) {
                    throw new RejectedAddress('invalid_osm_version');
                }
                $warnings = [];
                if ($street && $place) {
                    $warnings[] = 'both_street_and_place';
                }
                if (count($names) > 1 || ($street && $names && ! in_array($street, $names, true))) {
                    $warnings[] = 'associated_street_conflict';
                }
                $metadata = array_intersect_key($element, array_flip(['type', 'id', 'version', 'timestamp', 'changeset', 'nodes']));
                if (isset($element['members'])) {
                    $metadata['members'] = array_map(fn ($m) => array_intersect_key($m, array_flip(['type', 'ref', 'role'])), $element['members']);
                }
                yield ['source_id' => $key, 'row' => [
                    'source_id' => $key, 'osm_type' => $element['type'], 'osm_id' => $element['id'],
                    'osm_version' => $element['version'] ?? null, 'osm_updated_at' => $this->timestamp($element['timestamp'] ?? null),
                    'street' => $street, 'place' => $place, 'house_number' => $house,
                    'locality' => $text('addr:city'), 'postcode' => $text('addr:postcode'),
                    'label' => implode(', ', array_filter([$text('addr:city'), $street ?: $place, $house], fn ($v) => $v !== null)),
                    'geometry' => $this->geometry->build($element),
                    'point_method' => $element['type'] === 'node' ? 'osm_node' : 'point_on_surface',
                    'raw_data' => ['tags' => (object) $tags, 'osm' => $metadata, 'address_resolution' => ['method' => $method, 'associated_streets' => $relations]],
                ], 'warnings' => $warnings];
            } catch (RejectedAddress $error) {
                yield ['source_id' => $key, 'skip' => $error->getMessage()];
            }
        }
    }
}
