<?php

use App\Services\Routing\LocalCarRouterProvider;
use Illuminate\Contracts\Console\Kernel;

require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
$cases = json_decode(file_get_contents('/var/www/html/experiments/local-routing-poc/controls.json'), true, flags: JSON_THROW_ON_ERROR)['cases'];
$provider = $app->make(LocalCarRouterProvider::class);
$results = [];
foreach ($cases as $case) {
    $began = microtime(true);
    $result = $provider->analyze(['lon' => $case['start']['coordinate'][0], 'lat' => $case['start']['coordinate'][1]], [
        ['lon' => $case['target']['coordinate'][0], 'lat' => $case['target']['coordinate'][1], 'label' => $case['id']],
    ]);
    $results[$case['id']] = ['milliseconds' => (microtime(true) - $began) * 1000, 'response' => $result];
    fwrite(STDERR, $case['id'].' '.$result['results'][0]['status']."\n");
}
echo json_encode($results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)."\n";
