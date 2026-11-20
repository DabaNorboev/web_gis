<?php

namespace App\Http\Middleware;

use App\Services\Geocoding\GeocodingFailure;
use Closure;
use Illuminate\Http\Request;

/** Run before HandleCors, including preflight and method errors; foreign origins get no CORS grant. */
class PrivateGeocodingCors
{
    public function handle(Request $request, Closure $next): mixed
    {
        if (! $request->is('api/v1/geocoding/*', 'api/v1/place-analysis')) {
            return $next($request);
        }
        if ($request->is('api/v1/geocoding/*') && $request->method() !== 'POST') {
            throw new GeocodingFailure('METHOD_NOT_ALLOWED', 405);
        }
        $paths = config('cors.paths');
        config(['cors.paths' => []]);
        try {
            return $next($request);
        } finally {
            config(['cors.paths' => $paths]);
        }
    }
}
