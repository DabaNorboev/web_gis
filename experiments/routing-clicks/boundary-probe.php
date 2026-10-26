<?php

use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

require __DIR__.'/../../vendor/autoload.php';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
if (DB::selectOne('SHOW default_transaction_read_only')->default_transaction_read_only !== 'on') {
    throw new RuntimeException('READ ONLY required');
}
$cases = array_column(json_decode(file_get_contents(__DIR__.'/controls.json'), true)['cases'], null, 'id');
$inspections = json_decode(file_get_contents($argv[1]), true);
$out = [];
foreach ($inspections as $i) {
    if (! str_starts_with($i['id'], 'industrial_')) {
        continue;
    }
    $case = $cases[$i['id']];
    $p = $case['point'];
    foreach ($i['candidates'] as $candidate) {
        $f = array_values(array_filter($i['features'], fn ($f) => $f['id'] === $case['building_id'] && $f['kind'] === 'building'))[0];
        $out[$i['id']] = DB::selectOne(<<<'SQL'
 WITH b AS (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) geom),
 p AS (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(?,?),4326),32646) original,
 ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) matched)
 SELECT ST_Covers(b.geom,p.original) full_contains,ST_Distance(ST_Boundary(b.geom),p.original) boundary_distance_m,
 ST_Covers(ST_Buffer(b.geom,-.3),p.original) inset_contains,
 ST_GeometryType(ST_Intersection(b.geom,ST_MakeLine(p.original,p.matched))) full_intersection_type,
 ST_AsGeoJSON(ST_Intersection(ST_Buffer(b.geom,-.3),ST_MakeLine(p.original,p.matched))) inset_intersection
 FROM b CROSS JOIN p
 SQL, [json_encode($f['geometry']), $p['lon'], $p['lat'], $candidate['point']]);
    }
}
echo json_encode($out, JSON_PRETTY_PRINT)."\n";
