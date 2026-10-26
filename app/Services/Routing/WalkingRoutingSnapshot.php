<?php

namespace App\Services\Routing;

use JsonException;

/** Bounded, hash-checked source reads for the separate walking snapshot. */
class WalkingRoutingSnapshot
{
    private ?array $loaded = null;

    public function manifest(): array
    {
        if ($this->loaded !== null) {
            return $this->loaded;
        }
        $pin = config('routing.walking.manifest_sha256');
        $manifest = $this->read('manifest.json', $pin, 16_000_000);
        if (($manifest['mode'] ?? null) !== 'walking' || ($manifest['engine'] ?? null) !== 'ORS'
            || ($manifest['engine_version'] ?? null) !== '10.1.0' || ($manifest['profile'] ?? null) !== 'foot-walking'
            || ($manifest['version'] ?? null) !== config('routing.walking.version')
            || ($manifest['guard_cell_degrees'] ?? null) !== .005
            || ! is_array($manifest['guard_hashes'] ?? null) || ! is_array($manifest['way_hashes'] ?? null)
            || ! is_array($manifest['bbox'] ?? null) || count($manifest['bbox']) !== 4) {
            throw new RoutingDataException('Unsupported walking snapshot');
        }
        [$west, $south, $east, $north] = $manifest['bbox'];
        $this->position([$west, $south]);
        $this->position([$east, $north]);
        if ($west >= $east || $south >= $north) {
            throw new RoutingDataException('Invalid walking snapshot boundary');
        }

        return $this->loaded = $manifest;
    }

    public function contains(array $point): bool
    {
        [$lon, $lat] = $this->position([$point['lon'] ?? null, $point['lat'] ?? null]);
        [$west, $south, $east, $north] = $this->manifest()['bbox'];

        return $lon >= $west && $lon <= $east && $lat >= $south && $lat <= $north;
    }

    /** Original OSM highway rows keyed by positive OSM way ID. */
    public function ways(array $ids): array
    {
        if (count($ids) > 2000) {
            throw new RoutingDataException('Walking way request budget exceeded');
        }
        $manifest = $this->manifest();
        $result = [];
        $bytes = 0;
        foreach ($ids as $id) {
            if ((! is_int($id) && ! is_string($id)) || ! preg_match('/^[1-9][0-9]{0,18}$/D', (string) $id)
                || (string) (int) $id !== (string) $id) {
                throw new RoutingDataException('Invalid walking way identifier');
            }
            $name = 'ways/'.$id.'.json';
            if (! isset($manifest['way_hashes'][$name])) {
                throw new RoutingDataException('Walking source way unavailable');
            }
            if (isset($result[$id])) {
                continue;
            }
            $way = $this->read($name, $manifest['way_hashes'][$name], 1_000_000, $bytes);
            if (($way['id'] ?? null) !== (int) $id || ! is_array($way['nodes'] ?? null)
                || ! is_array($way['coordinates'] ?? null) || ! is_array($way['tags'] ?? null)
                || ! isset($way['tags']['highway']) || count($way['nodes']) < 2
                || count($way['nodes']) !== count($way['coordinates']) || count($way['nodes']) > 20_000) {
                throw new RoutingDataException('Invalid walking source way');
            }
            foreach ($way['coordinates'] as $i => $position) {
                $this->position($position);
                if (! is_int($way['nodes'][$i]) || $way['nodes'][$i] <= 0) {
                    throw new RoutingDataException('Invalid walking source node');
                }
            }
            $result[(int) $id] = $way;
        }

        return $result;
    }

    /** Read only cells touched by route segments and endpoint connectors. */
    public function features(array $coordinates, array $start, array $target): array
    {
        if (count($coordinates) > 20_000 || ! array_is_list($coordinates)) {
            throw new RoutingDataException('Walking coordinate budget exceeded');
        }
        $manifest = $this->manifest();
        $step = $manifest['guard_cell_degrees'];
        $positions = [[$start['lon'] ?? null, $start['lat'] ?? null], ...$coordinates, [$target['lon'] ?? null, $target['lat'] ?? null]];
        foreach ($positions as $point) {
            $this->position($point);
        }
        $cells = [];
        foreach (array_slice($positions, 1) as $i => $point) {
            $previous = $positions[$i];
            $minX = (int) floor((min($previous[0], $point[0]) - .00002) / $step);
            $maxX = (int) floor((max($previous[0], $point[0]) + .00002) / $step);
            $minY = (int) floor((min($previous[1], $point[1]) - .00002) / $step);
            $maxY = (int) floor((max($previous[1], $point[1]) + .00002) / $step);
            if (($maxX - $minX + 1) * ($maxY - $minY + 1) > 2000) {
                throw new RoutingDataException('Walking guard cell budget exceeded');
            }
            for ($x = $minX; $x <= $maxX; $x++) {
                for ($y = $minY; $y <= $maxY; $y++) {
                    $cells["guards/{$x}-{$y}.json"] = true;
                    if (count($cells) > 2000) {
                        throw new RoutingDataException('Walking guard cell budget exceeded');
                    }
                }
            }
        }
        // Endpoint ambiguity checks need every source road in the snap radius,
        // including roads across a cell edge from the selected point.
        foreach ([$positions[0], $positions[count($positions) - 1]] as $point) {
            $latMargin = 20.5 / 110_000;
            $lonMargin = 20.5 / (110_000 * max(.001, cos(deg2rad($point[1]))));
            $minX = (int) floor(($point[0] - $lonMargin) / $step);
            $maxX = (int) floor(($point[0] + $lonMargin) / $step);
            $minY = (int) floor(($point[1] - $latMargin) / $step);
            $maxY = (int) floor(($point[1] + $latMargin) / $step);
            if (($maxX - $minX + 1) * ($maxY - $minY + 1) > 2000) {
                throw new RoutingDataException('Walking guard cell budget exceeded');
            }
            for ($x = $minX; $x <= $maxX; $x++) {
                for ($y = $minY; $y <= $maxY; $y++) {
                    $cells["guards/{$x}-{$y}.json"] = true;
                    if (count($cells) > 2000) {
                        throw new RoutingDataException('Walking guard cell budget exceeded');
                    }
                }
            }
        }
        $features = [];
        $bytes = 0;
        foreach (array_keys($cells) as $name) {
            if (! isset($manifest['guard_hashes'][$name])) {
                continue; // Absent index entry means an empty prepared cell.
            }
            $rows = $this->read($name, $manifest['guard_hashes'][$name], 8_000_000, $bytes);
            if (! array_is_list($rows) || count($rows) > 50_000) {
                throw new RoutingDataException('Invalid walking guard cell');
            }
            foreach ($rows as $feature) {
                if (! is_array($feature) || ! in_array($feature['kind'] ?? null, ['line', 'node', 'building', 'water'], true)
                    || ! is_string($feature['id'] ?? null) || ! is_array($feature['geometry'] ?? null)
                    || (isset($feature['tags']) && ! is_array($feature['tags']))) {
                    throw new RoutingDataException('Invalid walking guard feature');
                }
                $features[$feature['kind'].':'.$feature['id']] = $feature;
                if (count($features) > 50_000) {
                    throw new RoutingDataException('Walking guard feature budget exceeded');
                }
            }
        }

        return array_values($features);
    }

    private function position(mixed $point): array
    {
        if (! is_array($point) || ! array_is_list($point) || count($point) !== 2) {
            throw new RoutingDataException('Invalid walking coordinate');
        }
        foreach ($point as $value) {
            if ((! is_float($value) && ! is_int($value)) || ! is_finite((float) $value)) {
                throw new RoutingDataException('Invalid walking coordinate');
            }
        }
        if (abs($point[0]) > 180 || abs($point[1]) > 90) {
            throw new RoutingDataException('Invalid walking coordinate');
        }

        return $point;
    }

    private function read(string $name, mixed $checksum, int $maximum, ?int &$bytes = null): array
    {
        if (! is_string($checksum) || ! preg_match('/^[a-f0-9]{64}$/D', $checksum)
            || ! preg_match('~^(manifest\.json|ways/[1-9][0-9]*\.json|guards/-?[0-9]+--?[0-9]+\.json)$~D', $name)) {
            throw new RoutingDataException('Invalid walking snapshot index');
        }
        $folder = config('routing.walking.snapshot_path');
        if (! is_string($folder) || $folder === '') {
            throw new RoutingDataException('Walking snapshot unavailable');
        }
        $root = realpath($folder);
        $path = $root === false ? false : realpath($root.'/'.$name);
        if ($path === false || ! str_starts_with($path, $root.'/') || ! is_file($path)) {
            throw new RoutingDataException('Walking snapshot unavailable');
        }
        $raw = @file_get_contents($path, length: $maximum + 1);
        if ($raw === false || strlen($raw) > $maximum || ! hash_equals($checksum, hash('sha256', $raw))) {
            throw new RoutingDataException('Walking snapshot unavailable or changed');
        }
        $bytes = ($bytes ?? 0) + strlen($raw);
        $setting = trim(ini_get('memory_limit'));
        $limit = $setting === '-1' ? 536_870_912 : (int) $setting * match (strtolower(substr($setting, -1))) {
            'g' => 1_073_741_824, 'm' => 1_048_576, 'k' => 1024, default => 1,
        };
        if (($name !== 'manifest.json' && $bytes > 12_000_000) || memory_get_usage(true) + strlen($raw) * 12 > $limit * .8) {
            throw new RoutingDataException('Walking snapshot byte budget exceeded');
        }
        try {
            $value = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new RoutingDataException('Invalid walking snapshot JSON');
        }
        if (! is_array($value)) {
            throw new RoutingDataException('Invalid walking snapshot data');
        }

        return $value;
    }
}
