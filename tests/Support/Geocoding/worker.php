<?php

use App\Services\Geocoding\GeocodingFailure;
use App\Services\Geocoding\GeocodingState;
use Illuminate\Contracts\Console\Kernel;
use Tests\Support\PostgisDatabase;

require __DIR__.'/../../../vendor/autoload.php';
$app = require __DIR__.'/../../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
$config = json_decode(getenv('G3_WORKER_DB'), true, flags: JSON_THROW_ON_ERROR);
PostgisDatabase::assertConfiguration($config);
config(['database.default' => 'pgsql', 'database.connections.pgsql' => $config, 'geocoding.api_key' => 'synthetic', 'geocoding.daily_limit' => 1]);
PostgisDatabase::connect(false);
$state = new GeocodingState;
echo "READY\n";
flush();
fgets(STDIN);
try {
    $state->start('synthetic-worker-'.$argv[1]);
    echo "ADMITTED\n";
    flush();
    fgets(STDIN); // Parent can kill us while the actual advisory slots are held.
    $state->finish();
} catch (GeocodingFailure $e) {
    echo $e->errorCode."\n";
    flush();
}
