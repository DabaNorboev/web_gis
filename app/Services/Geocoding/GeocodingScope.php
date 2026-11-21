<?php

namespace App\Services\Geocoding;

use App\Services\Gis\GeoJsonBoundary;
use Illuminate\Support\Facades\DB;

class GeocodingScope
{
    private ?string $geometry = null;

    private ?array $bounds = null;

    public function identity(): array
    {
        return ['scope_id' => config('geocoding.scope_id'), 'scope_sha256' => config('geocoding.scope_sha256')];
    }

    public function bounds(): array
    {
        $this->load();

        return $this->bounds;
    }

    public function covers(array $point): bool
    {
        [$west, $south, $east, $north] = $this->bounds();
        if ($point['lon'] < $west || $point['lon'] > $east || $point['lat'] < $south || $point['lat'] > $north) {
            return false;
        }

        return $this->gis(fn () => (bool) DB::selectOne('SELECT ST_Covers(ST_GeomFromGeoJSON(?), ST_SetSRID(ST_MakePoint(?, ?), 4326)) AS covered',
            [$this->geometry, $point['lon'], $point['lat']])->covered);
    }

    /** Distances describe provider points, never entrances or building contours. */
    public function nearby(array $origin, array $candidates): array
    {
        return $this->gis(function () use ($origin, $candidates) {
            $nearby = [];
            foreach ($candidates as $candidate) {
                if ($candidate['point'] === null) {
                    continue;
                }
                $distance = (float) DB::selectOne('SELECT ST_Distance(
                    ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
                    ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) AS metres',
                    [$origin['lon'], $origin['lat'], $candidate['point']['lon'], $candidate['point']['lat']])->metres;
                if ($distance <= 100) {
                    $candidate['reference_distance_m'] = $distance;
                    $nearby[] = $candidate;
                }
            }

            return $nearby;
        });
    }

    private function load(): void
    {
        if ($this->geometry !== null) {
            return;
        }
        try {
            $contents = @file_get_contents(config('geocoding.scope_path'));
            if (! is_string($contents) || ! hash_equals(config('geocoding.scope_sha256'), hash('sha256', $contents))) {
                throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
            }
            [$geometry, $bounds] = $this->gis(function () use ($contents) {
                $geometry = app(GeoJsonBoundary::class)->geometry($contents);
                $b = DB::selectOne('SELECT ST_XMin(b) AS west, ST_YMin(b) AS south, ST_XMax(b) AS east, ST_YMax(b) AS north FROM (SELECT Box3D(ST_GeomFromGeoJSON(?)) AS b) s', [$geometry]);

                return [$geometry, [(float) $b->west, (float) $b->south, (float) $b->east, (float) $b->north]];
            });
            $this->geometry = $geometry;
            $this->bounds = $bounds;
        } catch (\Throwable) {
            throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
        }
    }

    private function gis(\Closure $operation): mixed
    {
        return DB::transaction(function () use ($operation) {
            DB::statement("SET LOCAL statement_timeout = '2s'");
            DB::statement("SET LOCAL lock_timeout = '500ms'");

            return $operation();
        });
    }
}
