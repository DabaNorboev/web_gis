<?php

// Synthetic endpoint for the network-none runtime harness, never a production route.
use App\Services\Geocoding\GeoapifyTransport;
use App\Services\Geocoding\GeocodingFailure;
use App\Services\Geocoding\GeocodingState;
use Illuminate\Contracts\Console\Kernel;
use Tests\Support\PostgisDatabase;

require __DIR__.'/../../../vendor/autoload.php';
$app = require __DIR__.'/../../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
$input = json_decode(file_get_contents('/tmp/g3-fpm-input.json'), true, flags: JSON_THROW_ON_ERROR);
PostgisDatabase::assertConfiguration($input['database']);
config(['database.default' => 'pgsql', 'database.connections.pgsql' => $input['database'],
    'app.key' => 'base64:'.base64_encode(str_repeat('a', 32)), 'geocoding.api_key' => 'synthetic']);
PostgisDatabase::connect(false);
$state = new GeocodingState;
$transport = new class extends GeoapifyTransport
{
    public function synthetic(string $url, GeocodingState $state): array
    {
        if (! $this->available()) {
            throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
        }

        return $this->transfer($url, $state);
    }
};
$state->start('synthetic-fpm-ip');
file_put_contents('/tmp/g3-fpm-marker.json', json_encode(['phase' => 'admitted']));
$start = hrtime(true);
try {
    $transport->synthetic($input['url'], $state);
    $code = 'OK';
} catch (GeocodingFailure $e) {
    $code = $e->errorCode;
}
$result = ['phase' => 'finished', 'code' => $code, 'seconds' => (hrtime(true) - $start) / 1e9,
    'sapi' => PHP_SAPI, 'php' => PHP_VERSION, 'curl' => curl_version()['version'], 'ares' => curl_version()['ares']];
file_put_contents('/tmp/g3-fpm-marker.json', json_encode($result));
header('Content-Type: application/json');
echo json_encode($result);
