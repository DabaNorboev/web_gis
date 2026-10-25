<?php

use App\Services\Routing\LocalCarRouterProvider;
use App\Services\Routing\RoutingGeometryGuard;
use App\Services\Routing\RoutingSnapshot;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

require __DIR__.'/../../vendor/autoload.php';
// Replays may load the preserved implementation without changing the worktree.
if ($original = getenv('PLACELENS_BASELINE_ROUTING')) {
    foreach (['RoutingSnapshot', 'RoutingGeometryGuard', 'LocalCarRouterProvider'] as $class) {
        require $original.'/'.$class.'.php';
    }
}
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
set_exception_handler(function (Throwable $e) {
    fwrite(STDERR, get_class($e).' '.($e->getPrevious()?->getMessage() ?? 'Diagnostic failed')."\n");
    exit(1);
});
if (DB::selectOne('SHOW default_transaction_read_only')->default_transaction_read_only !== 'on') {
    throw new RuntimeException('READ ONLY required');
}
$input = $argv[1] ?? throw new RuntimeException('Input required');
$output = $argv[2] ?? throw new RuntimeException('Output required');
if (file_exists($output)) {
    throw new RuntimeException('Output exists');
}
$sample = json_decode(file_get_contents($input), true, flags: JSON_THROW_ON_ERROR);
$provider = app(LocalCarRouterProvider::class);
$guard = app(RoutingGeometryGuard::class);
$snapshot = app(RoutingSnapshot::class);
$results = [];
foreach ($sample['cases'] as $case) {
    $began = microtime(true);
    $row = ['id' => $case['id'], 'point' => $case['point'], 'choice' => $guard->resolve($snapshot, $case['point'])];
    foreach (['start', 'target'] as $end) {
        $a = $end === 'start' ? $case['point'] : $sample['reference'];
        $b = $end === 'target' ? $case['point'] : $sample['reference'];
        $row[$end] = $provider->analyze($a, [$b])['results'][0];
    }
    $row['milliseconds'] = (microtime(true) - $began) * 1000;
    $results[] = $row;
    fwrite(STDERR, $case['id'].' '.$row['choice']['status'].' '.$row['start']['status'].' '.$row['target']['status']."\n");
}
file_put_contents($output, json_encode(['sample_sha256' => hash_file('sha256', $input), 'at' => gmdate('c'), 'results' => $results], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)."\n");
