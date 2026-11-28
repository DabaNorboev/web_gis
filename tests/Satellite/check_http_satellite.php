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
    // Public control centres in EPSG:32646. Cloud and western edge centres were
    // chosen inside the service boundary using the June exclusion raster.
    // The former western centre lies in the source buffer outside the service boundary.
    $cases = [
        ['inside-200', 497230, 6209920, 200], ['inside-1000', 497230, 6209920, 1000],
        ['cloud-200', 490335, 6207095, 200], ['cloud-1000', 490335, 6207095, 1000],
        ['edge-200', 444905, 6206485, 200], ['edge-1000', 444905, 6206485, 1000],
        ['outside-buffer-1000', 444889.9938225126, 6206476.068324317, 1000],
        ['outside-200', 400000, 6200000, 200], ['outside-1000', 400000, 6200000, 1000],
    ];
    $results = [];
    foreach ($cases as [$name,$x,$y,$radius]) {
        $p = DB::selectOne('SELECT ST_X(p) lon, ST_Y(p) lat FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(?,?),32646),4326) p) s', [$x, $y]);
        $expected = (new SatelliteCatalogReader($runtime, config('satellite.sha256')))->forPoint((float) $p->lon, (float) $p->lat, $radius);
        $body = json_encode(['place' => ['kind' => 'point', 'lon' => (float) $p->lon, 'lat' => (float) $p->lat], 'radius_m' => $radius, 'date' => '2026-06-06']);
        $start = microtime(true);
        $raw = file_get_contents('http://127.0.0.1:18765/api/v1/place-analysis', false, stream_context_create(['http' => ['method' => 'POST', 'header' => "Content-Type: application/json\r\n", 'content' => $body, 'ignore_errors' => true]]));
        $seconds = microtime(true) - $start;
        $r = json_decode($raw, true);
        $headers = array_map('strtolower', $http_response_header);
        if (str_starts_with($name, 'outside')) {
            if (! str_contains($http_response_header[0], '422') || ($r['code'] ?? null) !== 'OUTSIDE_SERVICE_AREA'
                || isset($r['blocks']) || ! in_array('referrer-policy: no-referrer', $headers, true)
                || ! array_filter($headers, fn ($header) => str_starts_with($header, 'cache-control:') && str_contains($header, 'no-store'))) {
                throw new RuntimeException('Outside-city response contract failed for '.$name.'.');
            }
            $results[] = ['case' => $name, 'seconds' => $seconds, 'code' => 'OUTSIDE_SERVICE_AREA'];

            continue;
        }
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
        if (str_starts_with($name, 'edge')
            && $actual['selected']['coverage']['usable_pixels'] >= $actual['selected']['coverage']['circle_pixels']) {
            throw new RuntimeException('Edge uncertainty must survive');
        }
        $results[] = ['case' => $name, 'seconds' => $seconds, 'response_bytes' => strlen($raw), 'reader' => $expected['metrics'], 'selected_coverage' => $actual['selected']['coverage']];
        foreach ($actual['selected']['layers'] ?? [] as $source) {
            $lon = deg2rad((float) $p->lon);
            $lat = deg2rad((float) $p->lat);
            $z = 13;
            $tx = (int) floor(($lon + M_PI) / (2 * M_PI) * 2 ** $z);
            $ty = (int) floor((1 - log(tan($lat) + 1 / cos($lat)) / M_PI) / 2 * 2 ** $z);
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
    echo 'HTTP passed: '.count($results)." cases including outside-city guard + same-origin PNG\n";
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
