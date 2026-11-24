<?php

namespace Tests\Feature;

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

final class ImageryBasemapTest extends TestCase
{
    private const VIEWPORT = ['west' => 92.8, 'east' => 93.0, 'south' => 55.95, 'north' => 56.08, 'zoom' => 16];

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.google_map_tiles.key' => null, 'cache.default' => 'array']);
        Http::preventStrayRequests();
    }

    public function test_keyless_preview_only_allows_loopback_and_does_not_contact_google(): void
    {
        Http::fake();

        $this->postJson('/api/v1/basemap/imagery/viewport', self::VIEWPORT)
            ->assertOk()
            ->assertHeader('Cache-Control', 'no-store, private')
            ->assertExactJson(['provider' => 'google_hybrid']);
        $this->postJson('http://127.0.0.1/api/v1/basemap/imagery/viewport', self::VIEWPORT)
            ->assertOk()
            ->assertExactJson(['provider' => 'google_hybrid']);
        $this->postJson('https://placelens.example/api/v1/basemap/imagery/viewport', self::VIEWPORT)
            ->assertStatus(503)
            ->assertExactJson(['code' => 'IMAGERY_UNAVAILABLE']);
        $this->get('/api/v1/basemap/imagery/14/1/1')->assertNotFound();

        Http::assertNothingSent();
    }

    public function test_google_session_is_reused_and_attribution_tracks_the_viewport(): void
    {
        config(['services.google_map_tiles.key' => 'TEST_MAP_KEY']);
        Http::fake([
            'https://tile.googleapis.com/v1/createSession?*' => Http::response([
                'session' => 'TEST_MAP_SESSION', 'expiry' => (string) now()->addHour()->timestamp,
                'tileWidth' => 256, 'tileHeight' => 256,
            ]),
            'https://tile.googleapis.com/tile/v1/viewport?*' => Http::sequence()
                ->push(['copyright' => 'Map data © Google, Example', 'maxZoomRects' => [['maxZoom' => 19], ['maxZoom' => 17]]])
                ->push(['copyright' => 'Map data © Google, Another provider', 'maxZoomRects' => [['maxZoom' => 17]]]),
            'https://tile.googleapis.com/v1/2dtiles/14/12417/5101?*' => Http::sequence()
                ->push('example PNG', 200, ['Content-Type' => 'image/png', 'Cache-Control' => 'private, max-age=60', 'ETag' => '"example"'])
                ->push('', 304, ['Cache-Control' => 'private, max-age=60', 'ETag' => '"example"']),
        ]);

        $this->get('/api/v1/basemap/imagery/14/12417/5101')->assertStatus(503);
        Http::assertNothingSent();
        $this->postJson('/api/v1/basemap/imagery/viewport', self::VIEWPORT)
            ->assertOk()
            ->assertExactJson(['provider' => 'google', 'attribution' => 'Map data © Google, Example', 'max_zoom' => 19, 'tile_size' => 256]);
        $this->postJson('/api/v1/basemap/imagery/viewport', array_replace(self::VIEWPORT, ['zoom' => 17]))
            ->assertOk()
            ->assertJsonPath('attribution', 'Map data © Google, Another provider');
        $this->get('/api/v1/basemap/imagery/14/12417/5101')
            ->assertOk()->assertHeader('Content-Type', 'image/png')->assertHeader('ETag', '"example"')
            ->assertHeader('Cache-Control', 'max-age=60, private')->assertContent('example PNG');
        $this->get('/api/v1/basemap/imagery/14/12417/5101', ['If-None-Match' => '"example"'])
            ->assertStatus(304)->assertHeader('ETag', '"example"');

        Http::assertSentCount(5);
        Http::assertSent(fn (Request $request) => str_contains($request->url(), '/v1/createSession?key=TEST_MAP_KEY')
            && $request['mapType'] === 'satellite' && $request['layerTypes'] === ['layerRoadmap'] && $request['overlay'] === false);
        Http::assertSent(fn (Request $request) => str_contains($request->url(), '/tile/v1/viewport?')
            && str_contains($request->url(), 'north=56.08') && str_contains($request->url(), 'session=TEST_MAP_SESSION'));
        Http::assertSent(fn (Request $request) => str_contains($request->url(), '/v1/2dtiles/14/12417/5101?')
            && $request->hasHeader('If-None-Match', '"example"'));
    }

    public function test_invalid_coordinates_and_provider_failures_are_isolated(): void
    {
        config(['services.google_map_tiles.key' => 'TEST_MAP_KEY']);
        Http::fake(['https://tile.googleapis.com/v1/createSession?*' => Http::response(['error' => 'private upstream details'], 403)]);

        $this->postJson('/api/v1/basemap/imagery/viewport', array_replace(self::VIEWPORT, ['north' => 90]))
            ->assertUnprocessable()->assertJsonValidationErrors('north');
        $this->get('/api/v1/basemap/imagery/14/16384/5101')->assertNotFound();
        $this->get('/api/v1/basemap/imagery/23/0/0')->assertNotFound();
        Http::assertNothingSent();

        $this->postJson('/api/v1/basemap/imagery/viewport', self::VIEWPORT)
            ->assertStatus(503)->assertExactJson(['code' => 'IMAGERY_UNAVAILABLE']);
        Http::assertSentCount(1);
    }
}
