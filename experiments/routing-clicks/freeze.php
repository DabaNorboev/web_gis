<?php

use App\Services\Routing\RoutingSnapshot;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

require __DIR__.'/../../vendor/autoload.php';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
set_exception_handler(function (Throwable $e) {
    fwrite(STDERR, get_class($e).' '.($e->getPrevious()?->getMessage() ?? 'Diagnostic failed')."\n");
    exit(1);
});
if (DB::selectOne('SHOW default_transaction_read_only')->default_transaction_read_only !== 'on') {
    throw new RuntimeException('READ ONLY required');
}
$output = $argv[1] ?? throw new RuntimeException('Output required');
if (file_exists($output)) {
    throw new RuntimeException('Output exists');
}
$snapshot = app(RoutingSnapshot::class);
$anchors = [
    'lenina' => [92.8608847327261, 56.013183262064594],
    'centre_block' => [92.86009561971184, 56.01347636134341],
    'solnechny' => [92.9215002, 56.1117399],
    'right_bank' => [93.0410044, 56.0046333],
    'kapitanskaya' => [92.8952795, 55.9979911],
    'railway' => [92.8314134, 56.0077276],
    'stadium' => [92.8648439, 56.0133186],
    'industrial' => [92.9894382, 56.0702166],
];
$cases = [];
$buildings = [];
foreach ($anchors as $name => [$lon,$lat]) {
    $p = compact('lon', 'lat');
    $features = $snapshot->features([[$lon - .003, $lat - .002], [$lon + .003, $lat + .002]], $p, $p);
    $rows = DB::select(<<<'SQL'
        WITH src AS (
          SELECT j->>'id' id, ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(j->>'geometry'),4326),32646) geom
          FROM jsonb_array_elements(?::jsonb) j WHERE j->>'kind'='building'
        ), anchor AS (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(?,?),4326),32646) p), b AS (
          SELECT id,geom,p FROM src CROSS JOIN anchor WHERE ST_Area(geom)>=150 ORDER BY ST_Distance(geom,p),id LIMIT 1
        ), base AS (
          SELECT *,ST_PointOnSurface(geom) centre,ST_ClosestPoint(ST_Boundary(geom),p) edge,
          ST_PointN(ST_ExteriorRing(ST_GeometryN(geom,1)),1) corner FROM b
        ), points AS (
          SELECT base.*,v.name,v.p point FROM base CROSS JOIN LATERAL (VALUES
          ('centre',centre),('centre_e3',ST_Translate(centre,3,0)),('centre_w3',ST_Translate(centre,-3,0)),
          ('centre_n3',ST_Translate(centre,0,3)),('centre_s3',ST_Translate(centre,0,-3)),
          ('edge',edge),('edge_e3',ST_Translate(edge,3,0)),('edge_w3',ST_Translate(edge,-3,0)),
          ('corner',corner),('exterior5',ST_Translate(edge,5*sin(ST_Azimuth(centre,edge)),5*cos(ST_Azimuth(centre,edge))))) v(name,p)
        ) SELECT id,name,ST_AsGeoJSON(ST_Transform(geom,4326),9) building,
          ST_AsGeoJSON(ST_Transform(point,4326),12) point,ST_Covers(geom,point) inside FROM points
        SQL, [json_encode($features), $lon, $lat]);
    foreach ($rows as $r) {
        [$x,$y] = json_decode($r->point, true)['coordinates'];
        $cases[] = ['id' => $name.'_'.$r->name, 'group' => $name, 'variant' => $r->name, 'building_id' => $r->id,
            'point' => ['lon' => $x, 'lat' => $y], 'inside_selected_building' => (bool) $r->inside];
        $buildings[$r->id] = json_decode($r->building, true);
    }
}
$data = ['version' => 1, 'frozen_at' => gmdate('c'), 'manifest_sha256' => config('routing.manifest_sha256'),
    'reference' => ['lon' => 92.8712982, 'lat' => 56.0120993], 'anchors' => $anchors, 'buildings' => $buildings, 'cases' => $cases];
file_put_contents($output, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)."\n");
echo count($cases).' cases '.hash_file('sha256', $output)."\n";
