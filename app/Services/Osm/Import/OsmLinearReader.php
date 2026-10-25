<?php

namespace App\Services\Osm\Import;

use Generator;

class OsmLinearReader
{
    public const LIFECYCLE_TAGS = ['disused', 'abandoned', 'demolished', 'razed', 'construction', 'proposed'];

    public function __construct(private OsmSnapshotReader $snapshot) {}

    public function read(string $contents): array
    {
        return $this->snapshot->read($contents);
    }

    public function candidates(array $document, OsmLinearDataset $dataset): Generator
    {
        foreach ($document['elements'] as $element) {
            $key = $element['type'].'/'.$element['id'];
            try {
                $tags = $element['tags'] ?? [];
                if (! is_array($tags) || array_filter($tags, fn ($v) => ! is_string($v))) {
                    throw new RejectedAddress('invalid_tags');
                }
                if (! in_array($tags[$dataset->tag()] ?? '', $dataset->types(), true)) {
                    yield ['source_id' => $key, 'ignored' => 'tag_outside_scope'];

                    continue;
                }
                if (array_filter(self::LIFECYCLE_TAGS, fn ($tag) => ! in_array($tags[$tag] ?? '', ['', 'no', 'false', '0'], true))) {
                    yield ['source_id' => $key, 'ignored' => 'lifecycle_flag'];

                    continue;
                }
                if ($element['type'] !== 'way') {
                    throw new RejectedAddress('only_way_geometry_supported');
                }
                if (in_array($tags['area'] ?? '', ['yes', 'true', '1'], true)) {
                    throw new RejectedAddress('area_not_a_linear_centerline');
                }
                if (isset($element['version']) && (! is_int($element['version']) || $element['version'] <= 0)) {
                    throw new RejectedAddress('invalid_osm_version');
                }
                $geometry = $element['geometry'] ?? [];
                if (! is_array($geometry) || ! array_is_list($geometry) || count($geometry) < 2) {
                    throw new RejectedAddress('missing_or_short_way_geometry');
                }
                if (isset($element['nodes']) && (! is_array($element['nodes']) || ! array_is_list($element['nodes'])
                    || count($element['nodes']) !== count($geometry)
                    || array_filter($element['nodes'], fn ($id) => ! is_int($id) || $id <= 0))) {
                    throw new RejectedAddress('incomplete_way_nodes');
                }
                $coordinates = array_map(function ($point) {
                    if (! is_array($point) || ! is_numeric($point['lon'] ?? null) || ! is_numeric($point['lat'] ?? null)
                        || ! is_finite((float) $point['lon']) || ! is_finite((float) $point['lat'])
                        || abs((float) $point['lon']) > 180 || abs((float) $point['lat']) > 90) {
                        throw new RejectedAddress('invalid_or_missing_coordinates');
                    }

                    return [(float) $point['lon'], (float) $point['lat']];
                }, $geometry);
                yield ['source_id' => $key, 'row' => [
                    'source_id' => $key, 'osm_type' => 'way', 'osm_id' => $element['id'],
                    'osm_version' => $element['version'] ?? null, 'osm_updated_at' => $this->snapshot->timestamp($element['timestamp'] ?? null),
                    'feature_type' => $tags[$dataset->tag()], 'name' => $tags['name'] ?? null, 'ref' => $tags['ref'] ?? null,
                    'geometry' => ['type' => 'LineString', 'coordinates' => $coordinates],
                    'raw_data' => ['tags' => (object) $tags,
                        'osm' => array_intersect_key($element, array_flip(['type', 'id', 'version', 'timestamp', 'changeset', 'nodes']))],
                ]];
            } catch (RejectedAddress $error) {
                yield ['source_id' => $key, 'skip' => $error->getMessage()];
            }
        }
    }
}
