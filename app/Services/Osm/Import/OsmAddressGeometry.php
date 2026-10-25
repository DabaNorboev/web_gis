<?php

namespace App\Services\Osm\Import;

use Illuminate\Support\Facades\DB;

/** Reconstructs only complete, explicitly closed rings; never snaps or repairs geometry. */
class OsmAddressGeometry
{
    public function build(array $element): array
    {
        if ($element['type'] === 'node') {
            return ['type' => 'Point', 'coordinates' => $this->coordinate($element)];
        }
        if ($element['type'] === 'way') {
            $ring = $this->coordinates($element['geometry'] ?? []);
            $nodes = $element['nodes'] ?? null;
            if ($nodes !== null && (count($nodes) !== count($ring) || reset($nodes) !== end($nodes))) {
                throw new RejectedAddress('incomplete_way_nodes');
            }
            $this->closed($ring);

            return ['type' => 'Polygon', 'coordinates' => [$ring]];
        }
        if (($element['tags']['type'] ?? null) !== 'multipolygon') {
            throw new RejectedAddress('unsupported_relation');
        }
        $lines = ['outer' => [], 'inner' => []];
        $seen = [];
        foreach ($element['members'] ?? [] as $member) {
            $role = $member['role'] ?? '';
            // A nested relation cannot be safely ignored or inferred from its bounding box.
            if ($member['type'] !== 'way' || ! in_array($role, ['outer', 'inner'], true)) {
                throw new RejectedAddress('unsupported_multipolygon_member');
            }
            $key = $member['type'].'/'.$member['ref'];
            if (isset($seen[$key])) {
                throw new RejectedAddress('duplicate_multipolygon_member');
            }
            $seen[$key] = true;
            $lines[$role][] = $this->coordinates($member['geometry'] ?? []);
        }
        $outers = $this->rings($lines['outer']);
        $inners = $this->rings($lines['inner']);
        if (! $outers) {
            throw new RejectedAddress('missing_outer_ring');
        }
        $polygons = array_map(fn ($ring) => [$ring], $outers);
        foreach ($inners as $hole) {
            $matches = [];
            foreach ($outers as $index => $outer) {
                $check = DB::selectOne(<<<'SQL'
                    WITH g AS (SELECT ST_GeomFromGeoJSON(?) AS o, ST_GeomFromGeoJSON(?) AS i)
                    SELECT CASE WHEN ST_IsValid(o) AND ST_IsValid(i) THEN ST_Contains(o,i) ELSE false END AS inside FROM g
                    SQL, [json_encode(['type' => 'Polygon', 'coordinates' => [$outer]], JSON_THROW_ON_ERROR), json_encode(['type' => 'Polygon', 'coordinates' => [$hole]], JSON_THROW_ON_ERROR)]);
                if ($check->inside) {
                    $matches[] = $index;
                }
            }
            if (count($matches) !== 1) {
                throw new RejectedAddress('unassigned_or_ambiguous_inner_ring');
            }
            $polygons[$matches[0]][] = $hole;
        }

        return ['type' => 'MultiPolygon', 'coordinates' => $polygons];
    }

    private function coordinate(array $point): array
    {
        $lon = $point['lon'] ?? null;
        $lat = $point['lat'] ?? null;
        if (! is_numeric($lon) || ! is_numeric($lat) || ! is_finite((float) $lon) || ! is_finite((float) $lat)
            || $lon < -180 || $lon > 180 || $lat < -90 || $lat > 90) {
            throw new RejectedAddress('invalid_or_missing_coordinates');
        }

        return [(float) $lon, (float) $lat];
    }

    private function coordinates(array $points): array
    {
        if (count($points) < 2) {
            throw new RejectedAddress('incomplete_geometry');
        }

        return array_map(fn ($p) => is_array($p) ? $this->coordinate($p) : throw new RejectedAddress('incomplete_geometry'), $points);
    }

    private function closed(array $ring): void
    {
        if (count($ring) < 4 || $ring[0] !== $ring[count($ring) - 1]) {
            throw new RejectedAddress('unclosed_ring');
        }
    }

    private function rings(array $lines): array
    {
        $rings = [];
        while ($lines) {
            $ring = array_shift($lines);
            while ($ring[0] !== $ring[count($ring) - 1]) {
                $end = $ring[count($ring) - 1];
                $matches = [];
                foreach ($lines as $index => $line) {
                    if ($line[0] === $end || $line[count($line) - 1] === $end) {
                        $matches[] = $index;
                    }
                }
                if (count($matches) !== 1) {
                    throw new RejectedAddress('incomplete_or_ambiguous_ring');
                }
                $index = $matches[0];
                $next = $lines[$index];
                if ($next[0] !== $end) {
                    $next = array_reverse($next);
                }
                $ring = array_merge($ring, array_slice($next, 1));
                unset($lines[$index]);
            }
            $this->closed($ring);
            $rings[] = $ring;
        }

        return $rings;
    }
}
