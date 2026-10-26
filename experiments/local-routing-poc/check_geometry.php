<?php

require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
use Illuminate\Support\Facades\DB;
if (array_values((array) DB::selectOne('SHOW default_transaction_read_only'))[0] !== 'on') {
    throw new RuntimeException('Read-only required');
}
$result = DB::selectOne(<<<'SQL'
    SELECT
    ST_Length(ST_Intersection(ST_GeomFromText('LINESTRING(0 0,10 0)',32646),ST_Buffer(ST_GeomFromText('LINESTRING(5 -5,5 5)',32646),0.25))) perpendicular_m,
    ST_Length(ST_Intersection(ST_GeomFromText('LINESTRING(0 0,10 0)',32646),ST_Buffer(ST_GeomFromText('LINESTRING(0 0,10 0)',32646),0.25))) collinear_m,
    ST_Crosses(ST_GeomFromText('LINESTRING(0 0,10 0)',32646),ST_GeomFromText('LINESTRING(5 -5,5 5)',32646)) crosses_wall
SQL);
if (abs($result->perpendicular_m - .5) > 1e-8 || abs($result->collinear_m - 10) > 1e-8 || ! $result->crosses_wall) {
    throw new RuntimeException('Geometry attribution regression');
}
echo json_encode(['read_only' => true, 'analytic_geometry' => $result], JSON_PRETTY_PRINT)."\n";
