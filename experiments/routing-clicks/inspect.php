<?php

use App\Services\Routing\RoutingGeometryGuard;
use App\Services\Routing\RoutingSnapshot;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

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
$rows = json_decode(file_get_contents($input), true)['results'];
$results = [];
$snapshot = app(RoutingSnapshot::class);
$guard = app(RoutingGeometryGuard::class);
$m = $snapshot->manifest();
foreach ($rows as $row) {
    if (! str_ends_with($row['id'], '_centre') && ! str_ends_with($row['id'], 'edge_w3')) {
        continue;
    }
    $r = $row['start'];
    if ($r['status'] === 'AVAILABLE' || ! isset($r['road_choices']['start']['point'],$r['road_choices']['target']['point'])) {
        continue;
    }
    $a = $r['road_choices']['start']['point'];
    $b = $r['road_choices']['target']['point'];
    $data = Http::timeout(3)->get(config('routing.url').'/route/v1/driving/'.$a['lon'].','.$a['lat'].';'.$b['lon'].','.$b['lat'], ['radiuses' => '.25;.25', 'overview' => 'full', 'geometries' => 'geojson', 'annotations' => 'nodes'])->json();
    $line = $data['routes'][0]['geometry'];
    $nodes = $data['routes'][0]['legs'][0]['annotation']['nodes'];
    $features = (new ReflectionMethod($guard, 'prepareFeatures'))->invoke($guard, $snapshot->features($line['coordinates'], $r['start'], $r['target']));
    $sql = (new ReflectionMethod($guard, 'sql'))->invoke($guard, 'geometry.sql');
    $review = (array) DB::selectOne($sql, [json_encode($line), json_encode(['type' => 'Point', 'coordinates' => array_values($r['start'])]), json_encode(['type' => 'Point', 'coordinates' => array_values($r['target'])]), json_encode($features), json_encode($m['guard_sources']['service_geometry']), json_encode($m['bbox']), $m['boundary_margin_m'], json_encode($nodes), .25]);
    $issues = json_decode($review['issues'], true) ?? [];
    $ids = array_unique(array_merge(...array_values($issues)));
    $bad = array_values(array_filter($features, fn ($f) => in_array($f['id'], $ids)));
    $crossings = DB::select(<<<'SQL'
 WITH r AS (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) geom),
 src AS (SELECT j->>'id' id,j->'tags' tags,ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(j->>'geometry'),4326),32646) geom FROM jsonb_array_elements(?::jsonb) j),
 bad AS (SELECT *,ST_Intersection(src.geom,r.geom) crossing FROM src CROSS JOIN r WHERE id IN (SELECT jsonb_array_elements_text(?::jsonb)))
 SELECT bad.id,bad.tags,ST_AsGeoJSON(ST_Transform(bad.crossing,4326)) crossing,
 (SELECT jsonb_agg(jsonb_build_object('id',s.id,'tags',s.tags,'route_overlap_m',ST_Length(ST_Intersection(s.geom,ST_Buffer(r.geom,.25)))))
 FROM src s CROSS JOIN r WHERE jsonb_exists(s.tags,'highway') AND ST_DWithin(s.geom,bad.crossing,1)) roads
 FROM bad
 SQL, [json_encode($line), json_encode($features), json_encode(array_values($ids))]);
    $results[] = ['id' => $row['id'], 'review' => $review, 'crossings' => $crossings, 'raw' => $data, 'features' => $features];
    echo $row['id'].' '.json_encode($crossings, JSON_UNESCAPED_UNICODE)."\n";
}
file_put_contents($output, json_encode($results, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
