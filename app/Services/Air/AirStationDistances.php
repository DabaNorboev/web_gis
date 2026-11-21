<?php

namespace App\Services\Air;

use Illuminate\Support\Facades\DB;

class AirStationDistances
{
    public function nearestFirst(array $stations, array $point): array
    {
        $located = [];
        foreach ($stations as $station) {
            if (($station['crs'] ?? null) === 'EPSG:4326') {
                $located[] = ['id' => $station['id'], 'lon' => $station['lon'], 'lat' => $station['lat']];
            }
        }
        $distances = [];
        if ($located && DB::getDriverName() === 'pgsql') {
            $rows = DB::select(<<<'SQL'
                SELECT station.id,
                    ST_Distance(
                        ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
                        ST_SetSRID(ST_MakePoint(station.lon, station.lat), 4326)::geography
                    ) AS distance_m
                FROM jsonb_to_recordset(CAST(? AS jsonb)) AS station(id text, lon double precision, lat double precision)
                SQL, [$point['lon'], $point['lat'], json_encode($located, JSON_THROW_ON_ERROR)]);
            $distances = array_column($rows, 'distance_m', 'id');
        }

        foreach ($stations as &$station) {
            $distance = $distances[$station['id']] ?? null;
            $station['distance_m'] = $distance === null ? null : (float) $distance;
        }
        unset($station);
        usort($stations, fn (array $a, array $b) => ($a['distance_m'] ?? INF) <=> ($b['distance_m'] ?? INF));

        return $stations;
    }
}
