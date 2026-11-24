<?php

namespace App\Services\Basemap;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

final class GoogleMapTilesProvider
{
    private const URL = 'https://tile.googleapis.com';

    public function configured(): bool
    {
        return $this->key() !== '';
    }

    /** @param array<string, int|float> $bounds */
    public function viewport(array $bounds): ?array
    {
        try {
            $session = $this->session(create: true);
            if ($session === null) {
                return null;
            }

            $reply = $this->request()->get('/tile/v1/viewport', $bounds + [
                'session' => $session['token'], 'key' => $this->key(),
            ]);
        } catch (ConnectionException) {
            return null;
        }

        $credit = $reply->json('copyright');
        $rectangles = $reply->json('maxZoomRects');
        if (! $reply->ok() || ! is_string($credit) || trim($credit) === '' || strlen($credit) > 4096 || ! is_array($rectangles)) {
            return null;
        }

        $zoomLevels = [];
        foreach ($rectangles as $rect) {
            $zoom = $rect['maxZoom'] ?? null;
            if (is_int($zoom) && $zoom >= 0 && $zoom <= 22) {
                $zoomLevels[] = $zoom;
            }
        }

        return $zoomLevels === [] ? null : [
            'provider' => 'google',
            'attribution' => trim($credit),
            'max_zoom' => max($zoomLevels),
            'tile_size' => $session['tile_size'],
        ];
    }

    /** @param array<string, string> $validators */
    public function tile(int $z, int $x, int $y, array $validators): ?Response
    {
        $session = $this->session(create: false);
        if ($session === null) {
            return null;
        }

        try {
            return $this->request()->withHeaders($validators)->get("/v1/2dtiles/{$z}/{$x}/{$y}", [
                'session' => $session['token'], 'key' => $this->key(),
            ]);
        } catch (ConnectionException) {
            return null;
        }
    }

    private function key(): string
    {
        return trim((string) config('services.google_map_tiles.key', ''));
    }

    private function session(bool $create): ?array
    {
        $key = $this->key();
        if ($key === '') {
            return null;
        }

        $cacheKey = 'google-map-tiles:hybrid:'.hash('sha256', $key);
        $cached = Cache::get($cacheKey);
        if (is_array($cached)) {
            return $cached;
        }
        if (! $create) {
            return null;
        }

        $reply = $this->request()->withQueryParameters(['key' => $key])->post('/v1/createSession', [
            'mapType' => 'satellite',
            'layerTypes' => ['layerRoadmap'],
            'overlay' => false,
            'language' => 'ru-RU',
            'region' => 'RU',
        ]);
        $token = $reply->json('session');
        $expiry = filter_var($reply->json('expiry'), FILTER_VALIDATE_INT);
        $width = $reply->json('tileWidth');
        $ttl = $expiry === false ? 0 : $expiry - now()->getTimestamp() - 60;
        if (! $reply->ok() || ! is_string($token) || $token === '' || strlen($token) > 1024
            || $ttl <= 0 || ! in_array($width, [256, 512], true) || $width !== $reply->json('tileHeight')) {
            return null;
        }

        $session = ['token' => $token, 'tile_size' => $width];
        Cache::put($cacheKey, $session, $ttl);

        return $session;
    }

    private function request(): PendingRequest
    {
        return Http::baseUrl(self::URL)->withoutRedirecting()->connectTimeout(2)->timeout(5);
    }
}
