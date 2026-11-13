<?php

namespace App\Services\Satellite;

use Illuminate\Support\Facades\DB;
use InvalidArgumentException;
use RuntimeException;

/** Explicitly constructed internal reader. No provider binding or working activation. */
final class SatelliteCatalogReader
{
    private const VERSIONS = ['method_version' => 'placelens-s2-date-v1', 'mask_version' => 'scl456-dn-city-v1', 'legend_version' => 'ndvi-fixed-v2'];

    private const REASONS = ['valid', 'nodata', 'ambiguous_COG_DN1', 'saturated', 'cloud_shadow', 'cloud_or_cirrus', 'unclassified', 'SCL2_dark_or_shadow', 'snow', 'defective', 'numerical', 'unsupported_SCL', 'outside_target', 'outside_source_footprints'];

    private const MAX_BYTES = 16 * 1024 * 1024;

    private string $root;

    private int $bytes = 0;

    private float $began;

    private int $memory;

    public function __construct(string $directory, private readonly string $trustedSha256)
    {
        $root = realpath($directory);
        if ($root === false || ! preg_match('/^[a-f0-9]{64}$/D', $trustedSha256)) {
            throw new InvalidArgumentException('Explicit runtime directory and trusted catalog SHA-256 required.');
        }
        $this->root = $root;
    }

    /** The normal server entry uses the existing PostGIS metric projection, never frontend GIS. */
    public function forPoint(float $lon, float $lat, int $radius): array
    {
        if (! is_finite($lon) || ! is_finite($lat) || $lon < 90 || $lon > 96 || $lat < 0 || $lat > 84 || $radius < 200 || $radius > 1000) {
            throw new InvalidArgumentException('Point must be in northern UTM zone 46; radius 200–1000 m.');
        }
        $point = DB::transaction(function () use ($lon, $lat) {
            DB::statement("SET LOCAL statement_timeout = '500ms'");

            return DB::selectOne('SELECT ST_X(p) AS x, ST_Y(p) AS y FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(?, ?),4326),32646) AS p) AS projected', [$lon, $lat]);
        });

        return $this->forProjectedPoint((float) $point->x, (float) $point->y, $radius);
    }

    /** Native grid circles match A9 evidence: EPSG:32646 metres, pixel centres, full circle denominator. */
    public function forProjectedPoint(float $x, float $y, int $radius): array
    {
        if (! is_finite($x) || ! is_finite($y) || abs($x) > 1e7 || abs($y) > 1e7 || $radius < 200 || $radius > 1000) {
            throw new InvalidArgumentException('Finite projected point and radius 200–1000 m required.');
        }
        $this->began = microtime(true);
        $this->bytes = 0;
        $this->memory = memory_get_usage(true);
        try {
            $catalog = $this->catalog();
        } catch (RuntimeException $e) {
            return ['status' => 'UNAVAILABLE', 'reason' => 'SATELLITE_CATALOG_UNTRUSTED', 'available_dates' => [], 'releases' => []];
        }
        $rows = [];
        $available = [];
        foreach ($catalog['releases'] as $release) {
            $description = array_intersect_key($release, array_flip(['date', 'release_id', 'manifest_sha256', 'scenes', 'warnings', 'limitations']));
            try {
                $result = $this->circle($catalog, $release, $x, $y, $radius);
                $row = $description + $result;
                if ($row['status'] === 'READY') {
                    $available[] = $description;
                }
            } catch (RuntimeException $e) {
                $failure = $e->getMessage() === 'READ_BUDGET_EXCEEDED' ? 'READ_BUDGET_EXCEEDED' : 'SATELLITE_RELEASE_UNTRUSTED';
                $row = $description + ['status' => 'UNAVAILABLE', 'reason' => $failure,
                    'coverage' => null, 'mean_ndvi' => null, 'mean_ndvi_reason' => $failure];
            }
            $rows[] = $row;
        }

        return ['status' => 'READY', 'reason' => null, 'catalog_sha256' => $this->trustedSha256,
            'source_index_sha256' => $catalog['source_index']['sha256'], 'method_version' => $catalog['method_version'],
            'mask_version' => $catalog['mask_version'], 'legend_version' => $catalog['legend_version'],
            'available_dates' => $available, 'releases' => $rows,
            'metrics' => ['read_bytes' => $this->bytes, 'seconds' => microtime(true) - $this->began, 'PHP_peak_bytes' => memory_get_peak_usage(true)]];
    }

    private function bytes(string $relative, int $maximum, ?string $hash = null): string
    {
        $this->budget();
        $path = realpath($this->root.'/'.$relative);
        $this->check($path !== false && str_starts_with($path, $this->root.DIRECTORY_SEPARATOR), 'Unsafe/missing runtime path');
        $size = filesize($path);
        $this->check($size !== false && $size <= $maximum && $this->bytes + $size <= self::MAX_BYTES, 'READ_BUDGET_EXCEEDED');
        $raw = file_get_contents($path, false, null, 0, $maximum + 1);
        $this->check(is_string($raw) && strlen($raw) === $size && ($hash === null || hash_equals($hash, hash('sha256', $raw))), 'Runtime checksum');
        $this->bytes += strlen($raw);

        return $raw;
    }

    private function catalog(): array
    {
        $raw = $this->bytes('catalog.json', 2 * 1024 * 1024, $this->trustedSha256);
        $c = json_decode($raw, true);
        $this->check(is_array($c) && ($c['schema_version'] ?? null) === 1 && ($c['format'] ?? null) === 'placelens-satellite-cells-v1' &&
            ($c['status'] ?? null) === 'verified_offline_runtime', 'Unsupported runtime');
        foreach (self::VERSIONS as $key => $value) {
            $this->check(($c[$key] ?? null) === $value, 'Incompatible method');
        }
        $this->check(array_values($c['reason_codes'] ?? []) === self::REASONS && preg_match('/^[a-f0-9]{64}$/D', $c['source_index']['sha256'] ?? '') === 1, 'Incomplete runtime metadata');
        $g = $c['grid'] ?? [];
        $t = $g['transform'] ?? [];
        $this->check(($g['crs'] ?? null) === 'EPSG:32646' && count($t) === 6 && $t[0] == 10 && $t[1] == 0 && $t[3] == 0 && $t[4] == -10 &&
            is_numeric($t[2]) && is_numeric($t[5]) && ($g['width'] ?? 0) > 0 && $g['width'] <= 10000 && ($g['height'] ?? 0) > 0 && $g['height'] <= 10000 &&
            ($c['tile_side'] ?? null) === 256 && ($c['record_bytes'] ?? null) === 8 && count($c['releases'] ?? []) >= 1 && count($c['releases']) <= 6, 'Unsupported grid');
        $dates = [];
        foreach ($c['releases'] as $r) {
            $this->check(preg_match('/^\d{4}-\d{2}-\d{2}$/D', $r['date'] ?? '') === 1 && ! isset($dates[$r['date']]) &&
                count($r['scenes'] ?? []) >= 1 && count($r['scenes']) <= 8 && count($r['source_footprints'] ?? []) === count($r['scenes']), 'Incomplete release');
            $this->check(is_array($r['warnings'] ?? null) && is_array($r['limitations'] ?? null) && is_string($r['release_id'] ?? null) && preg_match('/^[a-f0-9]{64}$/D', $r['manifest_sha256'] ?? '') === 1, 'Incomplete release metadata');
            $dates[$r['date']] = true;
            $this->check(count($r['tiles'] ?? []) === (int) ceil($g['width'] / 256) * (int) ceil($g['height'] / 256), 'Missing runtime tiles');
            foreach ($r['source_footprints'] as $f) {
                $this->check(in_array($f['type'] ?? null, ['Polygon', 'MultiPolygon'], true), 'Unsupported footprint');
                $this->check(strlen(json_encode($f)) <= 65536, 'Footprint budget');
            }
            foreach ($r['tiles'] as $key => $tile) {
                $this->check(preg_match('/^\d+-\d+$/D', (string) $key) === 1 && $tile['path'] === 'cells/'.$r['date'].'/'.$key.'.bin' &&
                    preg_match('/^[a-f0-9]{64}$/D', $tile['sha256']) === 1 && $tile['bytes'] > 0 && $tile['bytes'] <= 524288, 'Invalid tile descriptor');
            }
        }

        return $c;
    }

    private function circle(array $catalog, array $release, float $x, float $y, int $radius): array
    {
        $g = $catalog['grid'];
        $t = $g['transform'];
        $cache = [];
        $sum = 0.0;
        $counts = array_fill_keys(['circle_pixels', 'source_footprint_pixels', 'prepared_pixels', 'outside_rectangle_pixels', 'inside_rectangle_outside_target_pixels', 'geographic_pixels', 'usable_pixels'], 0);
        $reasons = array_fill_keys(array_values($catalog['reason_codes']), 0);
        $sources = [];
        $left = (int) floor(($x - $radius - $t[2]) / 10);
        $right = (int) ceil(($x + $radius - $t[2]) / 10);
        $top = (int) floor(($t[5] - $y - $radius) / 10);
        $bottom = (int) ceil(($t[5] - $y + $radius) / 10);
        for ($row = $top; $row < $bottom; $row++) {
            $this->budget();
            for ($col = $left; $col < $right; $col++) {
                $px = $t[2] + ($col + .5) * 10;
                $py = $t[5] - ($row + .5) * 10;
                if (($px - $x) ** 2 + ($py - $y) ** 2 > $radius ** 2) {
                    continue;
                }
                $counts['circle_pixels']++;
                if ($row < 0 || $col < 0 || $row >= $g['height'] || $col >= $g['width']) {
                    $counts['outside_rectangle_pixels']++;
                    if ($this->covered($release['source_footprints'], $px, $py)) {
                        $counts['source_footprint_pixels']++;
                    }

                    continue;
                }
                $tr = intdiv($row, 256);
                $tc = intdiv($col, 256);
                $key = $tr.'-'.$tc;
                $width = min(256, $g['width'] - $tc * 256);
                $height = min(256, $g['height'] - $tr * 256);
                if (! isset($cache[$key])) {
                    $tile = $release['tiles'][$key] ?? null;
                    $this->check($tile !== null && $tile['bytes'] === $width * $height * 8, 'Incomplete tile');
                    $cache[$key] = $this->bytes($tile['path'], $tile['bytes'], $tile['sha256']);
                }
                $offset = (($row % 256) * $width + $col % 256) * 8;
                $v = unpack('gndvi/Creason/Csource/Ctarget/Cgeographic', $cache[$key], $offset);
                $this->check(is_finite($v['ndvi']) && isset($catalog['reason_codes'][$v['reason']]) && $v['source'] <= count($release['scenes']) &&
                    $v['target'] <= 1 && $v['geographic'] <= 1, 'Invalid cell');
                if (! $v['target']) {
                    $this->check($v['reason'] === 12 && $v['ndvi'] == -9999 && $v['source'] === 0 && $v['geographic'] === 0, 'Outside target payload');
                    $counts['inside_rectangle_outside_target_pixels']++;
                    $reasons['outside_target']++;
                    if ($this->covered($release['source_footprints'], $px, $py)) {
                        $counts['source_footprint_pixels']++;
                    }

                    continue;
                }
                $this->check($v['reason'] !== 12 && $v['geographic'] === (in_array($v['reason'], [1, 13], true) ? 0 : 1), 'Inconsistent geographic mask');
                $counts['prepared_pixels']++;
                $counts['geographic_pixels'] += $v['geographic'];
                $reasons[$catalog['reason_codes'][$v['reason']]]++;
                if ($v['source'] > 0) {
                    $counts['source_footprint_pixels']++;
                    $sources[$v['source']] = ($sources[$v['source']] ?? 0) + 1;
                } else {
                    $this->check($v['reason'] === 13, 'Missing source attribution');
                }
                if ($v['reason'] === 0) {
                    $this->check($v['geographic'] === 1 && abs($v['ndvi']) <= 1, 'Invalid usable NDVI');
                    $counts['usable_pixels']++;
                    $sum += $v['ndvi'];
                } else {
                    $this->check($v['ndvi'] == -9999, 'Unknown NDVI must remain nodata');
                }
            }
        }
        $this->check($counts['circle_pixels'] > 0 && $counts['circle_pixels'] === $counts['prepared_pixels'] + $counts['outside_rectangle_pixels'] + $counts['inside_rectangle_outside_target_pixels'], 'Circle accounting');
        $coverage = $counts + ['reason_counts' => $reasons, 'source_pixels' => (object) $sources, 'scope' => 'full_circle_native_pixel_centers'];
        foreach (['source_footprint', 'prepared', 'geographic', 'usable'] as $name) {
            $coverage[$name.'_fraction'] = $counts[$name.'_pixels'] / $counts['circle_pixels'];
        }
        $reason = $counts['prepared_pixels'] === 0 ? 'NO_PREPARED_DATA' : ($counts['geographic_pixels'] === 0 ? 'NO_GEOGRAPHIC_DATA' : ($counts['usable_pixels'] === 0 ? 'NO_USABLE_NDVI' : null));

        return ['status' => $reason === null ? 'READY' : 'UNAVAILABLE', 'reason' => $reason, 'coverage' => $coverage,
            'mean_ndvi' => $counts['usable_pixels'] > 0 ? $sum / $counts['usable_pixels'] : null, 'mean_ndvi_reason' => $reason];
    }

    private function covered(array $footprints, float $x, float $y): bool
    {
        foreach ($footprints as $f) {
            $polygons = $f['type'] === 'Polygon' ? [$f['coordinates']] : $f['coordinates'];
            foreach ($polygons as $polygon) {
                if (! $this->ring($polygon[0], $x, $y)) {
                    continue;
                }
                $hole = false;
                foreach (array_slice($polygon, 1) as $ring) {
                    if ($this->ring($ring, $x, $y)) {
                        $hole = true;
                        break;
                    }
                }
                if (! $hole) {
                    return true;
                }
            }
        }

        return false;
    }

    private function ring(array $ring, float $x, float $y): bool
    {
        $inside = false;
        for ($i = 0, $j = count($ring) - 1; $i < count($ring); $j = $i++) {
            [$ax,$ay] = $ring[$i];
            [$bx,$by] = $ring[$j];
            if (($ay > $y) !== ($by > $y) && $x < ($bx - $ax) * ($y - $ay) / ($by - $ay) + $ax) {
                $inside = ! $inside;
            }
        }

        return $inside;
    }

    private function budget(): void
    {
        $this->check(microtime(true) - $this->began <= 2 && memory_get_usage(true) - $this->memory <= 32 * 1024 * 1024, 'READ_BUDGET_EXCEEDED');
    }

    private function check(bool $condition, string $reason): void
    {
        if (! $condition) {
            throw new RuntimeException($reason);
        }
    }
}
