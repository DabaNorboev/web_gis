<?php

namespace App\Services\Routing;

/** Small, bounded pilot geometry in WGS84 / UTM 46N metres; not a general GIS API. */
final class WalkingGeometry
{
    private static int $operations = 0;

    private static ?float $deadline = null;

    public static function budget(?float $seconds): void
    {
        self::$operations = 0;
        self::$deadline = $seconds === null ? null : microtime(true) + $seconds;
    }

    private static function tick(): void
    {
        if (self::$deadline !== null && (self::$operations++ % 256) === 0) {
            self::memoryBudget();
        }
        if (self::$deadline !== null && (self::$operations > 1000000 || microtime(true) > self::$deadline)) {
            throw new RoutingDataException('Walking numeric geometry budget exceeded');
        }
    }

    public static function memoryBudget(): void
    {
        $setting = trim(ini_get('memory_limit'));
        $limit = $setting === '-1' ? 268435456 : (int) $setting * match (strtolower(substr($setting, -1))) {
            'g' => 1073741824, 'm' => 1048576, 'k' => 1024, default => 1,
        };
        if (memory_get_usage(true) > min(268435456, $limit * .8)) {
            throw new RoutingDataException('Walking geometry memory budget exceeded');
        }
    }

    public static function coordinate(mixed $p): bool
    {
        return is_array($p) && count($p) === 2 && isset($p[0], $p[1])
            && (is_int($p[0]) || is_float($p[0])) && (is_int($p[1]) || is_float($p[1]))
            && is_finite((float) $p[0]) && is_finite((float) $p[1])
            && $p[0] >= 90 && $p[0] <= 96 && $p[1] >= 0 && $p[1] <= 84;
    }

    public static function utm(array $p): array
    {
        self::tick();
        if (! self::coordinate($p)) {
            throw new RoutingDataException('Invalid walking pilot coordinate');
        }
        [$lon, $lat] = array_map('deg2rad', $p);
        $a = 6378137.0;
        $f = 1 / 298.257223563;
        $k = .9996;
        $e2 = $f * (2 - $f);
        $ep2 = $e2 / (1 - $e2);
        $n = $a / sqrt(1 - $e2 * sin($lat) ** 2);
        $t = tan($lat) ** 2;
        $c = $ep2 * cos($lat) ** 2;
        $q = cos($lat) * ($lon - deg2rad(93));
        $m = $a * ((1 - $e2 / 4 - 3 * $e2 ** 2 / 64 - 5 * $e2 ** 3 / 256) * $lat
            - (3 * $e2 / 8 + 3 * $e2 ** 2 / 32 + 45 * $e2 ** 3 / 1024) * sin(2 * $lat)
            + (15 * $e2 ** 2 / 256 + 45 * $e2 ** 3 / 1024) * sin(4 * $lat)
            - (35 * $e2 ** 3 / 3072) * sin(6 * $lat));

        return [500000 + $k * $n * ($q + (1 - $t + $c) * $q ** 3 / 6 + (5 - 18 * $t + $t * $t + 72 * $c - 58 * $ep2) * $q ** 5 / 120),
            $k * ($m + $n * tan($lat) * ($q * $q / 2 + (5 - $t + 9 * $c + 4 * $c * $c) * $q ** 4 / 24 + (61 - 58 * $t + $t * $t + 600 * $c - 330 * $ep2) * $q ** 6 / 720))];
    }

    public static function distance(array $a, array $b): float
    {
        return hypot($a[0] - $b[0], $a[1] - $b[1]);
    }

    public static function point(array $a, array $b, float $t): array
    {
        return [$a[0] + $t * ($b[0] - $a[0]), $a[1] + $t * ($b[1] - $a[1])];
    }

    /** Distance, projected point, fraction along original edge. */
    public static function project(array $p, array $a, array $b): array
    {
        self::tick();
        $dx = $b[0] - $a[0];
        $dy = $b[1] - $a[1];
        $d = $dx * $dx + $dy * $dy;
        $t = $d == 0 ? 0 : max(0, min(1, (($p[0] - $a[0]) * $dx + ($p[1] - $a[1]) * $dy) / $d));
        $q = self::point($a, $b, $t);

        return [self::distance($p, $q), $q, $t];
    }

    public static function cross(array $a, array $b, array $c): float
    {
        return ($b[0] - $a[0]) * ($c[1] - $a[1]) - ($b[1] - $a[1]) * ($c[0] - $a[0]);
    }

    public static function intersects(array $a, array $b, array $c, array $d): bool
    {
        self::tick();
        $e = 1e-7;
        if (max($a[0], $b[0]) + $e < min($c[0], $d[0]) || max($c[0], $d[0]) + $e < min($a[0], $b[0])
            || max($a[1], $b[1]) + $e < min($c[1], $d[1]) || max($c[1], $d[1]) + $e < min($a[1], $b[1])) {
            return false;
        }

        return self::cross($a, $b, $c) * self::cross($a, $b, $d) <= $e
            && self::cross($c, $d, $a) * self::cross($c, $d, $b) <= $e;
    }

    public static function overlap(array $a, array $b, array $c, array $d): bool
    {
        $length = self::distance($a, $b);
        if ($length < 1e-7 || abs(self::cross($a, $b, $c)) / $length > 1e-6 || abs(self::cross($a, $b, $d)) / $length > 1e-6) {
            return false;
        }
        $position = fn ($p) => (($p[0] - $a[0]) * ($b[0] - $a[0]) + ($p[1] - $a[1]) * ($b[1] - $a[1])) / $length ** 2;
        $x = $position($c);
        $y = $position($d);

        return (min(1, max($x, $y)) - max(0, min($x, $y))) * $length > 1e-6;
    }

    public static function insideRing(array $p, array $ring): bool
    {
        $inside = false;
        for ($i = 1; $i < count($ring); $i++) {
            $a = $ring[$i - 1];
            $b = $ring[$i];
            if (self::project($p, $a, $b)[0] < 1e-6) {
                return false;
            }
            if (($a[1] > $p[1]) !== ($b[1] > $p[1]) && $p[0] < $a[0] + ($p[1] - $a[1]) * ($b[0] - $a[0]) / ($b[1] - $a[1])) {
                $inside = ! $inside;
            }
        }

        return $inside;
    }

    public static function inside(array $p, array $polygon): bool
    {
        if (! self::insideRing($p, $polygon[0])) {
            return false;
        }
        foreach (array_slice($polygon, 1) as $ring) {
            if (self::insideRing($p, $ring)) {
                return false;
            }
        }

        return true;
    }

    public static function touches(array $a, array $b, array $polygon): bool
    {
        if (self::inside($a, $polygon) || self::inside($b, $polygon)) {
            return true;
        }
        foreach ($polygon as $ring) {
            for ($i = 1; $i < count($ring); $i++) {
                if (self::intersects($a, $b, $ring[$i - 1], $ring[$i])) {
                    return true;
                }
            }
        }

        return false;
    }

    public static function polygons(array $geometry): array
    {
        $parts = match ($geometry['type'] ?? null) {
            'Polygon' => [$geometry['coordinates']], 'MultiPolygon' => $geometry['coordinates'],
            default => throw new RoutingDataException('Unsupported walking polygon'),
        };
        $count = 0;
        foreach ($parts as &$polygon) {
            if (! is_array($polygon) || ! $polygon) {
                throw new RoutingDataException('Invalid walking polygon');
            }
            foreach ($polygon as &$ring) {
                if (! is_array($ring) || count($ring) < 4 || $ring[0] !== $ring[array_key_last($ring)]) {
                    throw new RoutingDataException('Invalid walking ring');
                }
                foreach ($ring as &$point) {
                    if (++$count > 100000) {
                        throw new RoutingDataException('Walking polygon budget');
                    }
                    $point = self::utm($point);
                }
                unset($point);
            }
            unset($ring);
        }
        unset($polygon);

        return $parts;
    }
}
