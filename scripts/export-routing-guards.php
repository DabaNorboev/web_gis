<?php

// Offline, read-only export of already imported obstacles and their provenance.
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

if (array_values((array) DB::selectOne('SHOW default_transaction_read_only'))[0] !== 'on') {
    throw new RuntimeException('Read-only connection required');
}
$folder = $argv[1] ?? throw new InvalidArgumentException('Output directory required');
if (! is_dir($folder) || file_exists($folder.'/obstacles.jsonl')) {
    throw new RuntimeException('Existing directory and absent output required');
}
$imports = DB::table('dataset_imports')->where('is_active', true)->whereIn('dataset_key', ['buildings', 'water'])->orderBy('dataset_key')
    ->get(['id', 'source', 'dataset_key', 'checksum_sha256', 'configuration_sha256', 'source_version', 'observed_at']);
if ($imports->count() !== 2) {
    throw new RuntimeException('Both obstacle datasets required');
}
$output = fopen($folder.'/obstacles.jsonl', 'x');
$counts = [];
foreach ($imports as $import) {
    $table = $import->dataset_key === 'buildings' ? 'osm_buildings' : 'osm_water';
    $kind = $import->dataset_key === 'buildings' ? 'building' : 'water';
    $counts[$kind] = 0;
    foreach (DB::cursor("SELECT osm_type,osm_id,ST_AsGeoJSON(geom,9) AS geometry FROM {$table} WHERE dataset_import_id=? AND geom && ST_MakeEnvelope(92.70,55.90,93.20,56.20,4326) ORDER BY id", [$import->id]) as $row) {
        fwrite($output, json_encode(['id' => $row->osm_type.'/'.$row->osm_id, 'kind' => $kind, 'geometry' => json_decode($row->geometry, true, flags: JSON_THROW_ON_ERROR)], JSON_THROW_ON_ERROR)."\n");
        $counts[$kind]++;
    }
}
fclose($output);
$water = $imports->firstWhere('dataset_key', 'water');
$coverage = DB::selectOne('SELECT ST_AsGeoJSON(service_geom,9) geometry,service_boundary_sha256 FROM dataset_coverages WHERE dataset_import_id=?', [$water->id]);
if (! $coverage) {
    throw new RuntimeException('Service coverage required');
}
file_put_contents($folder.'/guard-sources.json', json_encode(['imports' => $imports, 'counts' => $counts,
    'service_geometry' => json_decode($coverage->geometry, true, flags: JSON_THROW_ON_ERROR), 'service_boundary_sha256' => $coverage->service_boundary_sha256,
    'export_sha256' => hash_file('sha256', $folder.'/obstacles.jsonl')], JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR)."\n");
echo json_encode($counts)."\n";
