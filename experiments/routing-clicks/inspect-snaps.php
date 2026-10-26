<?php

use App\Services\Routing\RoutingGeometryGuard;
use App\Services\Routing\RoutingSnapshot;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

require __DIR__.'/../../vendor/autoload.php';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
set_exception_handler(function (Throwable $e) {
    fwrite(STDERR, get_class($e).' '.($e->getPrevious()?->getMessage() ?? 'Inspection failed')."\n");
    exit(1);
});
if (DB::selectOne('SHOW default_transaction_read_only')->default_transaction_read_only !== 'on') {
    throw new RuntimeException('READ ONLY required');
}
$input = $argv[1];
$output = $argv[2];
if (file_exists($output)) {
    throw new RuntimeException('Output exists');
}
$snapshot = app(RoutingSnapshot::class);
$guard = app(RoutingGeometryGuard::class);
$m = $snapshot->manifest();
$result = [];
foreach (json_decode(file_get_contents($input), true)['results'] as $r) {
    if ($r['choice']['status'] === 'SELECTED') {
        continue;
    }
    $p = $r['point'];
    $dy = 35.25 / 110000;
    $dx = $dy / cos(deg2rad($p['lat']));
    $f = (new ReflectionMethod($guard, 'prepareFeatures'))->invoke($guard, $snapshot->features([[$p['lon'] - $dx, $p['lat'] - $dy], [$p['lon'] + $dx, $p['lat'] + $dy]], $p, $p));
    $sql = (new ReflectionMethod($guard, 'sql'))->invoke($guard, 'snap-candidates.sql');
    $sql = explode('-- A metadata-only', $sql)[0].<<<'SQL'
 SELECT c.source_id,c.id,ST_AsGeoJSON(ST_Transform(c.matched,4326)) point,c.distance_m,c.access_allowed,
 (SELECT jsonb_agg(jsonb_build_object('code',code,'ids',ids)) FROM connector_issues WHERE endpoint=c.id) issues
 FROM candidates c ORDER BY distance_m
 SQL;
    $rows = DB::select($sql, [$p['lon'], $p['lat'], $p['lon'], $p['lat'], 35, json_encode($f), json_encode($m['guard_sources']['service_geometry']), json_encode($m['bbox']), $m['boundary_margin_m'], 0]);
    $result[] = ['id' => $r['id'], 'candidates' => $rows, 'features' => $f];
    echo $r['id'].' '.json_encode($rows)."\n";
}
file_put_contents($output, json_encode($result, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
