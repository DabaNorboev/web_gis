<?php

namespace App\Services\Satellite;

use RuntimeException;

final class SatelliteDelivery
{
    public function catalog(): array
    {
        $root = config('satellite.delivery');
        $pin = config('satellite.delivery_sha256');
        if (! is_string($root) || ! is_string($pin) || ! preg_match('/^[a-f0-9]{64}$/D', $pin)) {
            throw new RuntimeException('DELIVERY_UNAVAILABLE');
        }
        $raw = $this->read($root, 'catalog.json', 2 * 1024 * 1024, $pin);
        $c = json_decode($raw, true);
        if (! is_array($c) || ($c['schema_version'] ?? null) !== 1 || ($c['reader_sha256'] ?? null) !== config('satellite.sha256') || ($c['legend_version'] ?? null) !== 'ndvi-fixed-v2' || ($c['legend'] ?? null) !== config('satellite.legend')) {
            throw new RuntimeException('DELIVERY_UNTRUSTED');
        }

        return $c;
    }

    public function sources(array $c, array $release): ?array
    {
        if (($c['releases'][$release['date']]['manifest_sha256'] ?? null) !== $release['manifest_sha256']) {
            return null;
        }
        $sources = [];
        foreach (['true-color', 'ndvi'] as $layer) {
            $sources[$layer] = ['type' => 'raster', 'tiles' => ['/api/v1/satellite/'.config('satellite.delivery_sha256').'/'.$release['date'].'/'.$layer.'/{z}/{x}/{y}.png'],
                'bounds' => $c['bounds'], 'tileSize' => 256, 'minzoom' => 10, 'maxzoom' => 13, 'scheme' => 'xyz', 'attribution' => 'Copernicus Sentinel-2 L2A'];
        }

        return $sources;
    }

    public function tile(string $pin, string $date, string $layer, string $z, string $x, string $y): string
    {
        if ($pin !== config('satellite.delivery_sha256') || ! preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date) || ! in_array($layer, ['true-color', 'ndvi'], true)) {
            throw new RuntimeException('TILE_UNAVAILABLE');
        }
        foreach ([$z, $x, $y] as $part) {
            if (! preg_match('/^(0|[1-9][0-9]{0,4})$/D', $part)) {
                throw new RuntimeException('TILE_UNAVAILABLE');
            }
        }
        if ((int) $z < 10 || (int) $z > 13 || (int) $x >= 2 ** (int) $z || (int) $y >= 2 ** (int) $z) {
            throw new RuntimeException('TILE_UNAVAILABLE');
        }
        $c = $this->catalog();
        $key = "$date/$layer/$z/$x/$y";
        $tile = $c['tiles'][$key] ?? null;
        if (! $tile || $tile['bytes'] > 300000) {
            throw new RuntimeException('TILE_UNAVAILABLE');
        }
        $raw = $this->read(config('satellite.delivery'), $key.'.png', $tile['bytes'], $tile['sha256']);
        if (strlen($raw) !== $tile['bytes'] || substr($raw, 0, 8) !== "\x89PNG\r\n\x1a\n") {
            throw new RuntimeException('TILE_UNTRUSTED');
        }

        return $raw;
    }

    private function read(string $directory, string $relative, int $limit, string $hash): string
    {
        $root = realpath($directory);
        $path = $root === false ? false : realpath($root.'/'.$relative);
        if ($path === false || ! str_starts_with($path, $root.DIRECTORY_SEPARATOR) || ! is_file($path) || filesize($path) > $limit) {
            throw new RuntimeException('DELIVERY_UNAVAILABLE');
        }
        $raw = @file_get_contents($path, false, null, 0, $limit + 1);
        if (! is_string($raw) || strlen($raw) > $limit || ! hash_equals($hash, hash('sha256', $raw))) {
            throw new RuntimeException('DELIVERY_UNTRUSTED');
        }

        return $raw;
    }
}
