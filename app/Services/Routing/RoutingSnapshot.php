<?php

namespace App\Services\Routing;

class RoutingSnapshot
{
    private ?array $loaded = null;

    public function manifest(): array
    {
        if ($this->loaded !== null) {
            return $this->loaded;
        }
        $path = config('routing.snapshot_path').'/manifest.json';
        $raw = is_file($path) ? file_get_contents($path, length: 2_000_001) : false;
        if ($raw === false || strlen($raw) > 2_000_000 || ! hash_equals(config('routing.manifest_sha256'), hash('sha256', $raw))) {
            throw new RoutingDataException('Routing snapshot unavailable or changed');
        }
        $manifest = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
        if (($manifest['mode'] ?? null) !== 'driving' || ($manifest['engine_version'] ?? null) !== '5.27.1' || ($manifest['version'] ?? null) !== config('routing.version')) {
            throw new RoutingDataException('Unsupported routing snapshot');
        }

        return $this->loaded = $manifest;
    }

    public function contains(array $point): bool
    {
        [$west, $south, $east, $north] = $this->manifest()['bbox'];

        return $point['lon'] >= $west && $point['lon'] <= $east && $point['lat'] >= $south && $point['lat'] <= $north;
    }

    /** Load prepared cells along the line and its endpoint gaps, not a citywide scan. */
    public function features(array $coordinates, array $start, array $target): array
    {
        $manifest = $this->manifest();
        $step = $manifest['guard_cell_degrees'];
        $positions = [[$start['lon'], $start['lat']], ...$coordinates, [$target['lon'], $target['lat']]];
        $cells = [];
        foreach (array_slice($positions, 1) as $i => $point) {
            $previous = $positions[$i];
            for ($x = (int) floor((min($previous[0], $point[0]) - .00002) / $step); $x <= (int) floor((max($previous[0], $point[0]) + .00002) / $step); $x++) {
                for ($y = (int) floor((min($previous[1], $point[1]) - .00002) / $step); $y <= (int) floor((max($previous[1], $point[1]) + .00002) / $step); $y++) {
                    $cells["guards/{$x}-{$y}.json"] = true;
                    if (count($cells) > 2000) {
                        throw new RoutingDataException('Route exceeds guard request budget');
                    }
                }
            }
            if (count($cells) > 2000) {
                throw new RoutingDataException('Route exceeds guard request budget');
            }
        }
        $features = [];
        $bytes = 0;
        foreach (array_keys($cells) as $name) {
            if (! isset($manifest['guard_hashes'][$name])) {
                continue; // Empty prepared cell. Boundary coverage is checked separately.
            }
            $path = config('routing.snapshot_path').'/'.$name;
            $raw = is_file($path) ? file_get_contents($path, length: 8_000_001) : false;
            if ($raw === false || strlen($raw) > 8_000_000 || ! hash_equals($manifest['guard_hashes'][$name], hash('sha256', $raw))) {
                throw new RoutingDataException('Routing guard data changed');
            }
            $bytes += strlen($raw);
            $setting = trim(ini_get('memory_limit'));
            $limit = $setting === '-1' ? 268_435_456 : (int) $setting * match (strtolower(substr($setting, -1))) {
                'g' => 1_073_741_824, 'm' => 1_048_576, 'k' => 1024, default => 1,
            };
            if ($bytes > 12_000_000 || memory_get_usage(true) + strlen($raw) * 12 > $limit * .8) {
                throw new RoutingDataException('Routing guard byte budget exceeded');
            }
            foreach (json_decode($raw, true, flags: JSON_THROW_ON_ERROR) as $feature) {
                $features[$feature['kind'].':'.$feature['id']] = $feature;
            }
            if (count($features) > 50_000) {
                throw new RoutingDataException('Routing guard feature budget exceeded');
            }
        }

        return array_values($features);
    }
}
