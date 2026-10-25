<?php

namespace App\Services\Osm\Import;

use Generator;

/** Source polygons only: a park boundary is not measured vegetation cover. */
class OsmAreaReader
{
    public function __construct(private OsmSnapshotReader $snapshot, private OsmAddressGeometry $geometry) {}

    public function read(string $contents): array
    {
        return $this->snapshot->read($contents);
    }

    public function candidates(array $document, OsmAreaDataset $dataset): Generator
    {
        foreach ($document['elements'] as $element) {
            $key = $element['type'].'/'.$element['id'];
            try {
                $tags = $element['tags'] ?? [];
                if (! is_array($tags) || array_filter($tags, fn ($v) => ! is_string($v))) {
                    throw new RejectedAddress('invalid_tags');
                }
                $classification = $dataset->classify($tags);
                if (! $classification) {
                    yield ['source_id' => $key, 'ignored' => 'tag_outside_scope'];

                    continue;
                }
                if (array_filter(OsmLinearReader::LIFECYCLE_TAGS, fn ($tag) => ! in_array($tags[$tag] ?? '', ['', 'no', 'false', '0'], true))) {
                    yield ['source_id' => $key, 'ignored' => 'lifecycle_flag'];

                    continue;
                }
                if (! in_array($element['type'], ['way', 'relation'], true)) {
                    throw new RejectedAddress('point_without_footprint');
                }
                if (in_array($tags['area'] ?? '', ['no', 'false', '0'], true)) {
                    throw new RejectedAddress('explicit_non_area');
                }
                if (isset($element['version']) && (! is_int($element['version']) || $element['version'] <= 0)) {
                    throw new RejectedAddress('invalid_osm_version');
                }
                if (isset($element['nodes']) && (! is_array($element['nodes']) || ! array_is_list($element['nodes'])
                    || array_filter($element['nodes'], fn ($id) => ! is_int($id) || $id <= 0))) {
                    throw new RejectedAddress('invalid_way_nodes');
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
                yield ['source_id' => $key, 'row' => $classification + [
                    'source_id' => $key, 'osm_type' => $element['type'], 'osm_id' => $element['id'],
                    'osm_version' => $element['version'] ?? null,
                    'osm_updated_at' => $this->snapshot->timestamp($element['timestamp'] ?? null),
                    'name' => $tags['name'] ?? null, 'geometry' => $this->geometry->build($element),
                    'raw_data' => ['tags' => (object) $tags, 'osm' => $metadata],
                ]];
            } catch (RejectedAddress $error) {
                yield ['source_id' => $key, 'skip' => $error->getMessage()];
            }
        }
    }
}
