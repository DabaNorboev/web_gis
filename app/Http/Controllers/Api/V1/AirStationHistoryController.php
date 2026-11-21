<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Air\AirProvider;
use Illuminate\Http\JsonResponse;

class AirStationHistoryController
{
    public function __invoke(string $snapshot, string $station, AirProvider $air): JsonResponse
    {
        $result = $air->history($snapshot, $station);
        $status = match ($result['code'] ?? null) {
            'AIR_SNAPSHOT_CHANGED' => 409,
            'AIR_STATION_NOT_FOUND' => 404,
            'AIR_SOURCE_UNAVAILABLE' => 503,
            default => 200,
        };

        return response()->json($result, $status)
            ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
    }
}
