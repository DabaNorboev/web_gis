<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\Log;
use Tests\TestCase;

class SatelliteTileTest extends TestCase
{
    public function test_pinned_png_only_and_path_protection(): void
    {
        config(['app.debug' => true]);
        Log::shouldReceive('error')->never();
        $root = sys_get_temp_dir().'/a10-tile-'.bin2hex(random_bytes(6));
        mkdir($root.'/2026-06-06/ndvi/13/6200', 0777, true);
        $path = $root.'/2026-06-06/ndvi/13/6200/2500.png';
        $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=');
        file_put_contents($path, $png);
        $catalog = ['schema_version' => 1, 'reader_sha256' => str_repeat('a', 64), 'legend_version' => 'ndvi-fixed-v2',
            'legend' => config('satellite.legend'), 'tiles' => ['2026-06-06/ndvi/13/6200/2500' => ['bytes' => strlen($png), 'sha256' => hash('sha256', $png)]]];
        file_put_contents($root.'/catalog.json', json_encode($catalog));
        $pin = hash_file('sha256', $root.'/catalog.json');
        config(['satellite.delivery' => $root, 'satellite.delivery_sha256' => $pin, 'satellite.sha256' => str_repeat('a', 64)]);
        $url = '/api/v1/satellite/'.$pin.'/2026-06-06/ndvi/13/6200/2500.png';
        $r = $this->get($url)->assertOk()->assertHeader('Content-Type', 'image/png')->assertHeader('X-Content-Type-Options', 'nosniff')
            ->assertHeader('Referrer-Policy', 'no-referrer');
        $this->assertSame($png, $r->getContent());
        foreach ([str_replace('ndvi', 'true-color', $url), str_replace('/13/', '/14/', $url), str_replace('/6200/', '/99999/', $url),
            str_replace('2026-06-06', '2026-09-09', $url), str_replace($pin, str_repeat('b', 64), $url),
            '/api/v1/satellite/'.$pin.'/../catalog.json', str_replace('ndvi', '%2e%2e', $url)] as $bad) {
            $this->getJson($bad)->assertNotFound()->assertDontSee($root)->assertDontSee('stack');
        }
        file_put_contents($path, str_repeat('X', strlen($png)));
        $this->get($url)->assertNotFound()->assertHeader('Cache-Control', 'no-store, private')->assertDontSee($root);
        unlink($path);
        symlink(base_path('composer.json'), $path);
        $this->get($url)->assertNotFound()->assertDontSee('laravel');
        unlink($path);
        unlink($root.'/catalog.json');
        rmdir(dirname($path));
        rmdir($root.'/2026-06-06/ndvi/13');
        rmdir($root.'/2026-06-06/ndvi');
        rmdir($root.'/2026-06-06');
        rmdir($root);
    }
}
