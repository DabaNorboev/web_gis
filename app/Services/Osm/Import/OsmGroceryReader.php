<?php

namespace App\Services\Osm\Import;

use RuntimeException;

class OsmGroceryReader
{
    public const DATASET = 'grocery';

    public const TAG = 'shop';

    public const SHOPS = ['supermarket', 'convenience'];

    public const METHOD = 'osm-grocery-v1-geography-source-geometry-identity-and-equivalent-member';

    public function __construct(private OsmSnapshotReader $snapshot, private OsmAddressGeometry $geometry) {}

    public function read(string $contents): array
    {
        return $this->snapshot->read($contents);
    }

    /** Invalid selected geometry fails the snapshot, rather than publishing a false zero. */
    public function rows(array $document): array
    {
        $rows = [];
        foreach ($document['elements'] as $element) {
            $tags = $element['tags'] ?? [];
            if (! is_array($tags) || array_filter($tags, fn ($v) => ! is_string($v))) {
                throw new RuntimeException('Invalid grocery tags.');
            }
            if (! in_array($tags[static::TAG] ?? null, static::SHOPS, true)) {
                continue;
            }
            $inactive = false;
            foreach ([...OsmLinearReader::LIFECYCLE_TAGS, 'removed', 'closed'] as $key) {
                foreach ($this->lifecycleFlags($key) as $flag) {
                    $inactive = $inactive || ! in_array($tags[$flag] ?? '', ['', 'no', 'false', '0'], true);
                }
            }
            if ($inactive || $this->excluded($tags)) {
                continue;
            }
            if (($element['type'] !== 'node' && in_array($tags['area'] ?? '', ['no', 'false', '0'], true))
                || isset($element['version']) && (! is_int($element['version']) || $element['version'] < 1)) {
                throw new RuntimeException('Invalid grocery geometry/version.');
            }
            $street = $tags['addr:street'] ?? $tags['addr:place'] ?? null;
            $rows[] = [
                'source_id' => 'osm:'.$element['type'].':'.$element['id'],
                'name' => $this->text($tags['name'] ?? null),
                'address' => $this->text($tags['addr:full'] ?? ($street && isset($tags['addr:housenumber']) ? $street.', '.$tags['addr:housenumber'] : null)),
                'access' => $this->text($tags['access'] ?? null),
                'osm_version' => $element['version'] ?? null,
                'osm_updated_at' => $this->snapshot->timestamp($element['timestamp'] ?? null),
                'geometry' => $this->geometry->build($element),
                'raw_data' => ['tags' => (object) $tags, 'osm' => array_diff_key($element, ['tags' => 1, 'geometry' => 1])],
            ];
        }

        return $rows;
    }

    protected function excluded(array $tags): bool
    {
        return false;
    }

    protected function lifecycleFlags(string $key): array
    {
        return [$key, $key.':'.static::TAG];
    }

    private function text(?string $value): ?string
    {
        return $value !== null && trim($value) !== '' ? $value : null;
    }
}
