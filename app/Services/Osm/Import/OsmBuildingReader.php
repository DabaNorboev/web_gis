<?php

namespace App\Services\Osm\Import;

use Generator;

class OsmBuildingReader
{
    public function __construct(private OsmSnapshotReader $snapshot, private OsmAddressGeometry $geometry) {}

    public function read(string $contents): array
    {
        return $this->snapshot->read($contents);
    }

    public function candidates(array $document): Generator
    {
        $parents = [];
        foreach ($document['elements'] as $element) {
            if ($element['type'] !== 'relation' || ! is_array($element['tags'] ?? null)
                || ($element['tags']['type'] ?? null) !== 'multipolygon' || ! is_array($element['members'] ?? [])) {
                continue;
            }
            foreach ($element['members'] ?? [] as $member) {
                if (is_array($member) && ($member['type'] ?? null) === 'way'
                    && is_int($member['ref'] ?? null) && $member['ref'] > 0
                    && in_array($member['role'] ?? '', ['outer', 'inner'], true)) {
                    $parents[$member['ref']][] = ['osm_id' => $element['id'], 'role' => $member['role']];
                }
            }
        }
        foreach ($document['elements'] as $element) {
            $key = $element['type'].'/'.$element['id'];
            try {
                $tags = $element['tags'] ?? [];
                if (! is_array($tags) || array_filter($tags, fn ($v) => ! is_string($v))) {
                    throw new RejectedAddress('invalid_tags');
                }
                $building = ! in_array($tags['building'] ?? '', ['', 'no'], true);
                $part = ! in_array($tags['building:part'] ?? '', ['', 'no'], true);
                if (! $building && ! $part) {
                    throw new RejectedAddress('not_a_building_or_part');
                }
                if ($element['type'] === 'node') {
                    throw new RejectedAddress('point_without_footprint');
                }
                if (isset($element['version']) && (! is_int($element['version']) || $element['version'] <= 0)) {
                    throw new RejectedAddress('invalid_osm_version');
                }
                if ($element['type'] === 'relation') {
                    $members = $element['members'] ?? [];
                    if (! is_array($members) || ! array_is_list($members)) {
                        throw new RejectedAddress('invalid_relation_members');
                    }
                    foreach ($members as $member) {
                        if (! is_array($member) || ! in_array($member['type'] ?? null, ['node', 'way', 'relation'], true)
                            || ! is_int($member['ref'] ?? null) || $member['ref'] <= 0 || ! is_string($member['role'] ?? null)) {
                            throw new RejectedAddress('invalid_relation_members');
                        }
                    }
                }
                $metadata = array_intersect_key($element, array_flip(['type', 'id', 'version', 'timestamp', 'changeset', 'nodes']));
                if (isset($element['members'])) {
                    $metadata['members'] = array_map(fn ($m) => array_intersect_key($m, array_flip(['type', 'ref', 'role'])), $element['members']);
                }
                yield ['source_id' => $key, 'row' => [
                    'source_id' => $key, 'osm_type' => $element['type'], 'osm_id' => $element['id'],
                    'osm_version' => $element['version'] ?? null,
                    'osm_updated_at' => $this->snapshot->timestamp($element['timestamp'] ?? null),
                    'feature_kind' => $part ? 'part' : 'building',
                    'geometry' => $this->geometry->build($element),
                    'parent_relations' => $element['type'] === 'way' ? ($parents[$element['id']] ?? []) : [],
                    'raw_data' => ['tags' => (object) $tags, 'osm' => $metadata],
                ]];
            } catch (RejectedAddress $error) {
                yield ['source_id' => $key, 'skip' => $error->getMessage()];
            }
        }
    }
}
