<?php

use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\Http;

require __DIR__.'/../../vendor/autoload.php';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
$output = $argv[1];
if (file_exists($output)) {
    throw new RuntimeException('Output exists');
}
$sample = json_decode(file_get_contents(__DIR__.'/controls.json'), true);
$points = array_column($sample['cases'], 'point', 'id');
$reference = $sample['reference'];
$cases = [
    'corrected_edge' => [$points['industrial_edge'], [$reference]],
    'corrected_centre' => [$points['industrial_centre'], [$reference]],
    'mixed' => [$reference, [$points['industrial_edge'], $points['stadium_edge'], ['lon' => 91, 'lat' => 56]]],
    'both_outside' => [['lon' => 91, 'lat' => 56], [['lon' => 91, 'lat' => 56.01]]],
    'ambiguous' => [$reference, [$points['right_bank_edge']]],
    'radius' => [$points['stadium_centre'], [$reference]],
    'access' => [$points['centre_block_centre'], [$reference]],
];
$results = [];
foreach ($cases as $id => [$start, $places]) {
    $data = ['mode' => 'driving', 'start' => $start, 'places' => $places];
    $response = Http::timeout(20)->acceptJson()->post('http://nginx/api/v1/trips/analyze', $data);
    if ($response->status() !== 200 || ! str_contains($response->header('Cache-Control'), 'no-store')) {
        throw new RuntimeException('Unexpected HTTP response: '.$id);
    }
    $body = $response->json();
    foreach ($body['results'] as $i => $row) {
        if ($row['start'] != $start || $row['target'] != $places[$i] || $row['diagnostics']['version'] !== 1) {
            throw new RuntimeException('Point or diagnostic contract mismatch: '.$id);
        }
        if ($row['status'] !== 'AVAILABLE') {
            foreach (['distance', 'duration'] as $metric) {
                if ($row['route'] !== null || $row['metrics'][$metric]['value'] !== null || $row['metrics'][$metric]['quality']['method'] !== null) {
                    throw new RuntimeException('Rejected route has metrics: '.$id);
                }
            }
        } elseif ($row['route']['distance_m'] !== $row['metrics']['distance']['value']) {
            throw new RuntimeException('Metric mismatch');
        }
    }
    $results[$id] = $body;
    echo $id.' '.json_encode(array_column($body['results'], 'status'))."\n";
}
if (array_column($results['mixed']['results'], 'status') !== ['AVAILABLE', 'NEEDS_REFINEMENT', 'OUTSIDE_PILOT']
    || $results['corrected_edge']['results'][0]['status'] !== 'AVAILABLE'
    || $results['ambiguous']['results'][0]['road_choices']['target']['status'] !== 'CHOOSE'
    || $results['both_outside']['results'][0]['diagnostics']['issues'][0]['location'] !== 'both_endpoints') {
    throw new RuntimeException('Acceptance control failed');
}
file_put_contents($output, json_encode($results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)."\n");
