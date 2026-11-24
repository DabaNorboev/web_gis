<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Basemap\GoogleMapTilesProvider;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

final class ImageryBasemapController
{
    public function viewport(Request $request, GoogleMapTilesProvider $provider): JsonResponse
    {
        $input = $request->validate([
            'north' => ['required', 'numeric', 'between:-85.052,85.052', 'gt:south'],
            'south' => ['required', 'numeric', 'between:-85.052,85.052'],
            'east' => ['required', 'numeric', 'between:-180,180', 'different:west'],
            'west' => ['required', 'numeric', 'between:-180,180'],
            'zoom' => ['required', 'integer', 'between:0,22'],
        ]);

        $imagery = $provider->configured()
            ? $provider->viewport($input)
            : (in_array($request->getHost(), ['localhost', '127.0.0.1', '[::1]'], true) ? ['provider' => 'google_hybrid'] : null);
        if ($imagery === null) {
            return response()->json(['code' => 'IMAGERY_UNAVAILABLE'], 503, ['Cache-Control' => 'no-store']);
        }

        return response()->json($imagery, 200, ['Cache-Control' => 'no-store']);
    }

    public function tile(Request $request, GoogleMapTilesProvider $provider, int $z, int $x, int $y): Response
    {
        if ($z > 22 || $x >= (1 << $z) || $y >= (1 << $z) || ! $provider->configured()) {
            return response('', 404)->header('Cache-Control', 'no-store');
        }

        $validators = [];
        foreach (['If-None-Match', 'If-Modified-Since'] as $header) {
            $value = $request->header($header);
            if (is_string($value) && strlen($value) <= 512) {
                $validators[$header] = $value;
            }
        }

        $tile = $provider->tile($z, $x, $y, $validators);
        if ($tile === null || (! $tile->ok() && $tile->status() !== 304)) {
            return response('', $tile?->status() === 404 ? 404 : 503)->header('Cache-Control', 'no-store');
        }

        $headers = ['Cache-Control' => 'no-store'];
        foreach (['Cache-Control', 'ETag', 'Last-Modified', 'Expires'] as $header) {
            if ($tile->header($header) !== '') {
                $headers[$header] = $tile->header($header);
            }
        }
        if ($tile->status() === 304) {
            return response('', 304, $headers);
        }

        $type = strtolower(trim(explode(';', $tile->header('Content-Type'))[0]));
        $body = $tile->body();
        if (! in_array($type, ['image/jpeg', 'image/png'], true) || $body === '' || strlen($body) > 2_097_152) {
            return response('', 503)->header('Cache-Control', 'no-store');
        }

        return response($body, 200, $headers + ['Content-Type' => $type]);
    }
}
