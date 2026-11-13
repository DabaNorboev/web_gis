<?php

use App\Services\Satellite\SatelliteCatalogReader;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;
use Tests\Support\PostgisDatabase;

require __DIR__.'/../../vendor/autoload.php';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
PostgisDatabase::connect(true);
$report = getenv('SATELLITE_HTTP_REPORT');
if (! $report || ! getenv('SATELLITE_HTTP_METRICS')) {
    throw new RuntimeException('Explicit test report paths required');
}
$runtime = config('satellite.runtime');
$delivery = config('satellite.delivery');
foreach ([$runtime, $delivery] as $directory) {
    // Linux mount flag proves test runtime really is mounted read-only.
    $mounts = file('/proc/mounts');
    if (! array_filter($mounts, fn ($m) => str_contains($m, ' '.$directory.' ') && preg_match('/ ro[, ]/', $m))) {
        throw new RuntimeException('Read-only mount required');
    }
}
file_put_contents(getenv('SATELLITE_HTTP_METRICS'), '');
$server = proc_open(['php', '-S', '127.0.0.1:18765', 'tests/Satellite/http-router.php'], [0 => ['pipe', 'r'], 1 => ['file', '/tmp/a10-http-server.log', 'a'], 2 => ['file', '/tmp/a10-http-server.log', 'a']], $pipes, base_path());
try {
    for ($i = 0; $i < 50; $i++) {
        $s = @fsockopen('127.0.0.1', 18765);
        if ($s) {
            fclose($s);
            break;
        }
        usleep(100000);
    }
    $cases = [['inside-200', 497230, 6209920, 200], ['inside-1000', 497230, 6209920, 1000],
        ['cloud-200', null, null, 200], ['cloud-1000', null, null, 1000], ['edge-200', null, null, 200], ['edge-1000', null, null, 1000], ['outside-200', 400000, 6200000, 200], ['outside-1000', 400000, 6200000, 1000]];
    // Synthetic review points, no personal locations. Reuse retained A9 test circle centres.
    $review = json_decode(file_get_contents(base_path('data/satellite/reviews/2026-06-06-city-a9-5-01/city-boundary-circles.json')), true);
    $edge = $review[0]['center_utm'];
    $catalog = json_decode(file_get_contents($runtime.'/catalog.json'), true);
    $june = array_values(array_filter($catalog['releases'], fn ($r) => $r['date'] === '2026-06-06'))[0];
    $cloud = null;
    foreach ($june['tiles'] as $key => $tile) {
        $raw = file_get_contents($runtime.'/'.$tile['path']);
        for ($o = 0; $o < strlen($raw); $o += 8) {
            if (ord($raw[$o + 4]) === 5) {
                [$tr,$tc] = array_map('intval', explode('-', $key));
                $w = min(256, $catalog['grid']['width'] - $tc * 256);
                $cell = intdiv($o, 8);
                $t = $catalog['grid']['transform'];
                $cloud = [$t[2] + ($tc * 256 + $cell % $w + .5) * 10, $t[5] - ($tr * 256 + intdiv($cell, $w) + .5) * 10];
                break 2;
            }
        }
    }
    $results = [];
    foreach ($cases as [$name,$x,$y,$radius]) {
        if (str_starts_with($name, 'cloud')) {
            [$x,$y] = $cloud;
        }
        if (str_starts_with($name, 'edge')) {
            [$x,$y] = $edge;
        }
        $p = DB::selectOne('SELECT ST_X(p) lon, ST_Y(p) lat FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(?,?),32646),4326) p) s', [$x, $y]);
        $expected = (new SatelliteCatalogReader($runtime, config('satellite.sha256')))->forPoint((float) $p->lon, (float) $p->lat, $radius);
        $body = json_encode(['place' => ['kind' => 'point', 'lon' => (float) $p->lon, 'lat' => (float) $p->lat], 'radius_m' => $radius, 'date' => '2026-06-06']);
        $start = microtime(true);
        $raw = file_get_contents('http://127.0.0.1:18765/api/v1/place-analysis', false, stream_context_create(['http' => ['method' => 'POST', 'header' => "Content-Type: application/json\r\n", 'content' => $body, 'ignore_errors' => true]]));
        $seconds = microtime(true) - $start;
        $r = json_decode($raw, true);
        if (! str_contains($http_response_header[0], '200') || ($r['blocks']['satellite']['status'] ?? null) !== 'READY') {
            throw new RuntimeException('HTTP failed '.$name);
        }
        if (($expected['metrics']['read_bytes'] ?? PHP_INT_MAX) > 16 * 1024 * 1024) {
            throw new RuntimeException('Read budget');
        }
        $actual = $r['blocks']['satellite']['data'];
        foreach ($expected['releases'] as $i => $release) {
            if (json_decode(json_encode($release['coverage']), true) != $actual['releases'][$i]['coverage'] || abs(($release['mean_ndvi'] ?? 0) - ($actual['releases'][$i]['mean_ndvi'] ?? 0)) > 1e-12) {
                throw new RuntimeException('Circle mismatch '.$name);
            }
        }
        if (strlen($raw) > 300000 || str_contains($raw, '/satellite/runtime') || ! in_array('Referrer-Policy: no-referrer', $http_response_header)) {
            throw new RuntimeException('Response contract');
        }
        if (str_starts_with($name, 'cloud') && $actual['selected']['coverage']['reason_counts']['cloud_or_cirrus'] === 0) {
            throw new RuntimeException('Cloud case missing');
        }
        if ($name === 'edge-1000' && $actual['selected']['coverage']['inside_rectangle_outside_target_pixels'] !== 1) {
            throw new RuntimeException('Unknown edge pixel must survive');
        }
        if (str_starts_with($name, 'outside') && ($actual['selected']['mean_ndvi'] !== null || $actual['available_dates'] !== [])) {
            throw new RuntimeException('Unknown case');
        }
        $results[] = ['case' => $name, 'seconds' => $seconds, 'response_bytes' => strlen($raw), 'reader' => $expected['metrics'], 'selected_coverage' => $actual['selected']['coverage']];
        foreach ($actual['selected']['layers'] ?? [] as $source) {
            $lon = deg2rad((float) $p->lon);
            $lat = deg2rad((float) $p->lat);
            $z = 13;
            $tx = (int) floor(($lon + M_PI) / (2 * M_PI) * 2 ** $z);
            $ty = (int) floor((1 - log(tan($lat) + 1 / cos($lat)) / M_PI) / 2 * 2 ** $z);
            if (str_starts_with($name, 'outside')) {
                continue;
            }
            $url = str_replace(['{z}', '{x}', '{y}'], [$z, $tx, $ty], $source['tiles'][0]);
            $tileStart = microtime(true);
            $png = file_get_contents('http://127.0.0.1:18765'.$url, false, stream_context_create(['http' => ['ignore_errors' => true]]));
            if (! str_contains($http_response_header[0], '200') || substr($png, 0, 8) !== "\x89PNG\r\n\x1a\n" || ! in_array('Content-Type: image/png', $http_response_header)) {
                throw new RuntimeException('Tile HTTP failed');
            }
            $results[array_key_last($results)]['assets'][] = ['seconds' => microtime(true) - $tileStart, 'bytes' => strlen($png)];
        }
    }
    file_put_contents($report, json_encode(['passed' => true, 'cases' => $results], JSON_PRETTY_PRINT));
    echo 'HTTP passed: '.count($results)." circles + same-origin PNG\n";
} catch (Throwable $e) {
    fwrite(STDERR, $e->getMessage()."\n");
    $failed = true;
} finally {
    proc_terminate($server);
    proc_close($server);
}

if (isset($failed)) {
    exit(1);
}
