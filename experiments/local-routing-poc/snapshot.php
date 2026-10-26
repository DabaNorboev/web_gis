<?php

require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$ro = array_values((array) Illuminate\Support\Facades\DB::selectOne('SHOW default_transaction_read_only'))[0];
if ($ro !== 'on') {
    throw new RuntimeException('Read-only connection required');
}
$hashes = [];
foreach (['dataset_imports', 'transport_stops', 'transport_routes', 'transport_stop_routes', 'dataset_coverages', 'osm_addresses', 'osm_buildings', 'osm_roads', 'osm_railways', 'osm_green_areas', 'osm_water'] as $table) {
    $hashes[$table] = Illuminate\Support\Facades\DB::selectOne("SELECT count(*) AS count,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY row_to_json(t)::text),'')) AS hash FROM {$table} t");
}
echo json_encode(['read_only' => $ro, 'hashes' => $hashes], JSON_PRETTY_PRINT)."\n";
