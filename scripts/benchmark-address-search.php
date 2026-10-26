<?php

use App\Services\Osm\Search\AddressSearchService;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

// Run inside php: php scripts/benchmark-address-search.php before|after [runs=5] [report-directory]
require dirname(__DIR__).'/vendor/autoload.php';
$app = require dirname(__DIR__).'/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

$label = $argv[1] ?? '';
$runs = filter_var($argv[2] ?? '5', FILTER_VALIDATE_INT);
if (! in_array($label, ['before', 'after'], true) || $runs === false || $runs < 1 || $runs > 20) {
    fwrite(STDERR, "Usage: php scripts/benchmark-address-search.php before|after [runs=5, max=20] [report-directory]\n");
    exit(1);
}
$directory = $argv[3] ?? 'data/reports/address-search-'.now('Asia/Krasnoyarsk')->format('Y-m-d');
$path = base_path($directory.'/'.$label.'.json');
if (file_exists($path)) {
    throw new RuntimeException('Refusing to overwrite an existing benchmark report: '.$path);
}
$import = DB::table('dataset_imports')->where('source', 'OpenStreetMap')->where('dataset_key', 'addresses')
    ->where('is_active', true)->where('status', 'succeeded')->first();
if (! $import) {
    throw new RuntimeException('An active local address snapshot is required.');
}
$fingerprint = DB::selectOne('SELECT count(*) AS rows, md5(string_agg(md5(to_jsonb(a)::text),\'\' ORDER BY id)) AS hash FROM osm_addresses a WHERE dataset_import_id=?', [$import->id]);
$report = ['label' => $label, 'measured_at' => gmdate('c'), 'scope' => 'service, one PHP process, one warmup per query, no concurrent load',
    'runs' => $runs, 'dataset_import_id' => $import->id, 'source_checksum_sha256' => $import->checksum_sha256,
    'source_rows' => $fingerprint->rows, 'source_rows_fingerprint' => $fingerprint->hash, 'queries' => []];
foreach (['Мира 10', 'Киренского 32', 'Ленина 102', 'Мира', 'Красноярск Мира 10', 'Красноярск Киренского 32', 'Красноярск Ленина 102', 'г. Красноярск, ул. Ленина, 102', 'Ленина 102, Красноярск', 'Солонцы Мира 10', 'Несуществующаяулица 99999'] as $query) {
    app(AddressSearchService::class)->search($query);
    $times = [];
    for ($i = 0; $i < $runs; $i++) {
        $start = hrtime(true);
        $result = app(AddressSearchService::class)->search($query);
        $times[] = round((hrtime(true) - $start) / 1e6, 3);
    }
    sort($times);
    $n = count($times);
    $median = $n % 2 ? $times[intdiv($n, 2)] : ($times[$n / 2 - 1] + $times[$n / 2]) / 2;
    $row = ['query' => $query, 'median_ms' => round($median, 3), 'min_ms' => min($times), 'max_ms' => max($times),
        'results' => array_map(fn ($r) => ['id' => $r['id'], 'label' => $r['label'], 'match_type' => $r['match_type'], 'objects' => array_column($r['objects'], 'id')], $result['data'])];
    $report['queries'][] = $row;
    echo json_encode(['query' => $query, 'median_ms' => $row['median_ms'], 'groups' => count($row['results'])], JSON_UNESCAPED_UNICODE)."\n";
}
if (! is_dir(dirname($path))) {
    mkdir(dirname($path), 0775, true);
}
file_put_contents($path, json_encode($report, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR)."\n");
echo 'Report: '.$path."\n";
