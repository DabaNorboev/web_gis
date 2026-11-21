<?php

namespace App\Http\Middleware;

use App\Services\Geocoding\GeocodingFailure;
use App\Services\Geocoding\GeocodingState;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

class LimitGeocodingRequest
{
    public static function requestId(Request $request): ?string
    {
        try {
            $body = json_decode($request->getContent(), true, 24, JSON_THROW_ON_ERROR);
            $id = is_array($body) ? ($body['request_id'] ?? null) : null;

            return is_string($id) && Str::isUuid($id, 4) ? $id : null;
        } catch (\Throwable) {
            return null;
        }
    }

    public function handle(Request $request, Closure $next): mixed
    {
        if (strlen($request->getContent()) > 8192) {
            throw new GeocodingFailure('REQUEST_TOO_LARGE', 413);
        }
        if (strtolower(trim(explode(';', $request->header('Content-Type', ''))[0])) !== 'application/json'
            || ! in_array('application/json', $request->getAcceptableContentTypes(), true)) {
            throw new GeocodingFailure('UNSUPPORTED_MEDIA_TYPE', 415);
        }
        try {
            $body = json_decode($request->getContent(), false, 24, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new GeocodingFailure('INVALID_REQUEST', 422);
        }
        if (! $body instanceof \stdClass || $request->query->count() !== 0) {
            throw new GeocodingFailure('INVALID_REQUEST', 422);
        }
        app(GeocodingState::class)->rate($request->ip(), in_array($request->route('operation'), ['confirm', 'reconfirm'], true));

        return $next($request);
    }
}
