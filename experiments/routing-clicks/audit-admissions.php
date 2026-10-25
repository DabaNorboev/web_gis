<?php

use App\Services\Routing\OriginalRoutingGeometryGuard;
use App\Services\Routing\RoutingGeometryGuard;
use App\Services\Routing\RoutingSnapshot;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

require __DIR__.'/../../vendor/autoload.php';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
if (DB::selectOne('SHOW default_transaction_read_only')->default_transaction_read_only !== 'on') {
    throw new RuntimeException('READ ONLY required');
}
$before = array_column(json_decode(file_get_contents($argv[1]), true)['results'], null, 'id');
$after = json_decode(file_get_contents($argv[2]), true)['results'];
$output = $argv[3];
if (file_exists($output)) {
    throw new RuntimeException('Output exists');
}
$oldFolder = realpath(__DIR__.'/../../data/reports/goal5-routing-2026-10-23/resume/original-routing');
$oldClass = str_replace('class RoutingGeometryGuard', 'class OriginalRoutingGeometryGuard', file_get_contents($oldFolder.'/RoutingGeometryGuard.php'));
$oldPath = $oldFolder.'/OriginalRoutingGeometryGuard.php';
file_put_contents($oldPath, $oldClass);
require $oldPath;
$oldGuard = new OriginalRoutingGeometryGuard;
$guard = app(RoutingGeometryGuard::class);
$snapshot = app(RoutingSnapshot::class);
$results = [];
foreach ($after as $case) {
    foreach (['start', 'target'] as $end) {
        $row = $case[$end];
        if ($row['status'] !== 'AVAILABLE' || $before[$case['id']][$end]['status'] === 'AVAILABLE') {
            continue;
        }
        $a = $row['road_choices']['start']['point'];
        $b = $row['road_choices']['target']['point'];
        $raw = Http::timeout(3)->get(config('routing.url').'/route/v1/driving/'.$a['lon'].','.$a['lat'].';'.$b['lon'].','.$b['lat'],
            ['radiuses' => '.25;.25', 'overview' => 'full', 'geometries' => 'geojson', 'annotations' => 'nodes'])->json();
        $route = $raw['routes'][0];
        if ($route['geometry'] !== $row['route']['geometry'] || $route['distance'] != $row['route']['distance_m'] || $route['duration'] != $row['route']['duration_s']) {
            throw new RuntimeException('Raw route changed');
        }
        $nodes = $route['legs'][0]['annotation']['nodes'];
        $old = $oldGuard->review($snapshot, $route['geometry'], $row['start'], $row['target'], $nodes);
        $new = $guard->review($snapshot, $route['geometry'], $row['start'], $row['target'], $nodes);
        if ($new['status'] !== 'AVAILABLE' || $old['status'] === 'AVAILABLE'
            || array_diff($old['checks'], ['SNAP_THROUGH_BUILDING', 'ROUTE_BARRIER_REVIEW'])) {
            throw new RuntimeException('Unexpected admission reason');
        }
        $results[] = ['id' => $case['id'], 'direction' => $end, 'old_review' => $old, 'new_review' => $new,
            'raw_metrics_unchanged' => true, 'raw' => $raw];
        echo $case['id'].' '.$end.' '.implode(',', $old['checks'])."\n";
    }
}
file_put_contents($output, json_encode($results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)."\n");
