<?php

use App\Services\Routing\LocalCarRouterProvider;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

require __DIR__.'/../../vendor/autoload.php';
if ($original = getenv('PLACELENS_BASELINE_ROUTING')) {
    foreach (['RoutingSnapshot', 'RoutingGeometryGuard', 'LocalCarRouterProvider'] as $class) {
        require $original.'/'.$class.'.php';
    }
}
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
if (DB::selectOne('SHOW default_transaction_read_only')->default_transaction_read_only !== 'on') {
    throw new RuntimeException('READ ONLY required');
}
$output = $argv[1];
if (file_exists($output)) {
    throw new RuntimeException('Output exists');
}
$cases = json_decode(file_get_contents(__DIR__.'/../local-routing-poc/controls.json'), true)['cases'];
$results = [];
foreach ($cases as $case) {
    $a = array_combine(['lon', 'lat'], $case['start']['coordinate']);
    $b = array_combine(['lon', 'lat'], $case['target']['coordinate']);
    $results[$case['id']] = app(LocalCarRouterProvider::class)->analyze($a, [$b])['results'][0];
    echo $case['id'].' '.$results[$case['id']]['status']."\n";
}
file_put_contents($output, json_encode($results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)."\n");
