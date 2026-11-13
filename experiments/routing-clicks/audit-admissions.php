<?php

use App\Services\Routing\OriginalRoutingGeometryGuard;
use App\Services\Routing\RoutingGeometryGuard;
use App\Services\Routing\RoutingSnapshot;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

use function PlaceLens\RoutingClicks\withOriginalGuard;
use function PlaceLens\RoutingClicks\writeAuditResults;

require __DIR__.'/audit-filesystem.php';
require __DIR__.'/../../vendor/autoload.php';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
if (DB::selectOne('SHOW default_transaction_read_only')->default_transaction_read_only !== 'on') {
    throw new RuntimeException('READ ONLY required');
}
$before = array_column(json_decode(file_get_contents($argv[1]), true)['results'], null, 'id');
$after = json_decode(file_get_contents($argv[2]), true)['results'];
$output = $argv[3];
if (file_exists($output) || is_link($output)) {
    throw new RuntimeException('Output exists');
}
$sourceFile = __DIR__.'/../../data/reports/goal5-routing-2026-10-23/resume/original-routing/RoutingGeometryGuard.php';
$results = withOriginalGuard($sourceFile, static function (string $oldPath) use ($before, $after): array {
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

    return $results;
});
writeAuditResults($output, $results);
