<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Satellite\SatelliteDelivery;
use Throwable;

final class SatelliteTileController
{
    public function __invoke(string $pin, string $date, string $layer, string $z, string $x, string $y, SatelliteDelivery $delivery)
    {
        try {
            return response($delivery->tile($pin, $date, $layer, $z, $x, $y), 200, [
                'Content-Type' => 'image/png', 'X-Content-Type-Options' => 'nosniff',
                'Cache-Control' => 'public, max-age=31536000, immutable', 'Referrer-Policy' => 'no-referrer',
            ]);
        } catch (Throwable) {
            return response()->json(['code' => 'SATELLITE_TILE_UNAVAILABLE'], 404)
                ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
        }
    }
}
