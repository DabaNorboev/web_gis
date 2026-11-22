<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Air\AirProvider;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AirSnapshotHourController
{
    public function __invoke(string $snapshot, Request $request, AirProvider $air): JsonResponse
    {
        $result = $air->hour($snapshot, $request->query()['observed_at_raw'] ?? null);
        $status = match ($result['code'] ?? null) {
            'AIR_SNAPSHOT_CHANGED' => 409,
            'AIR_INVALID_HOUR', 'AIR_HOUR_OUTSIDE_WINDOW' => 422,
            'AIR_SOURCE_UNAVAILABLE' => 503,
            default => 200,
        };

        return response()->json($result, $status)
            ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
    }
}
