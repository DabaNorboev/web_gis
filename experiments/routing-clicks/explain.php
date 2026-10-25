<?php

use App\Services\Routing\RoutingGeometryGuard;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

require __DIR__.'/../../vendor/autoload.php';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
if (DB::selectOne('SHOW default_transaction_read_only')->default_transaction_read_only !== 'on') {
    throw new RuntimeException('READ ONLY required');
}
$guard = app(RoutingGeometryGuard::class);
$line = ['type' => 'LineString', 'coordinates' => [[92.86, 56.01], [92.861, 56.01]]];
$f = [['id' => 'way/1', 'kind' => 'line', 'geometry' => $line, 'nodes' => [1, 2], 'tags' => ['highway' => 'residential'], 'access_allowed' => true]];
$area = ['type' => 'Polygon', 'coordinates' => [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]];
$sql = (new ReflectionMethod($guard, 'sql'))->invoke($guard, 'geometry.sql');
$bindings = [json_encode($line), json_encode(['type' => 'Point', 'coordinates' => $line['coordinates'][0]]), json_encode(['type' => 'Point', 'coordinates' => $line['coordinates'][1]]), json_encode($f), json_encode($area), '[92.7,55.9,93.2,56.2]', 1000, '[1,2]', .25];
$out = [];
foreach (['on', 'off'] as $mode) {
    DB::statement('SET jit = '.$mode);
    $plan = DB::select('EXPLAIN (ANALYZE,FORMAT JSON) '.$sql, $bindings);
    $out[$mode] = json_decode($plan[0]->{'QUERY PLAN'}, true);
    echo $mode.' '.json_encode(['execution_ms' => $out[$mode][0]['Execution Time'], 'jit' => $out[$mode][0]['JIT'] ?? null])."\n";
}
file_put_contents($argv[1], json_encode($out));
