<?php

use App\Services\Geocoding\GeoapifyTransport;
use App\Services\Geocoding\GeocodingState;
use Illuminate\Contracts\Console\Kernel;
use Tests\Support\PostgisDatabase;

require __DIR__.'/../../../vendor/autoload.php';
$app = require __DIR__.'/../../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
$config = json_decode(getenv('G3_WORKER_DB'), true, flags: JSON_THROW_ON_ERROR);
PostgisDatabase::assertConfiguration($config);
config(['database.default' => 'pgsql', 'database.connections.pgsql' => $config, 'geocoding.api_key' => 'synthetic']);
PostgisDatabase::connect(false);
$state = new GeocodingState;
$state->start('synthetic-abort-ip');
file_put_contents(getenv('G3_ABORT_MARKER'), 'admitted');
$client = new class extends GeoapifyTransport
{
    public function local(string $url, GeocodingState $state): array
    {
        return $this->transfer($url, $state);
    }
};
try {
    $client->local(getenv('G3_ABORT_URL'), $state);
} catch (Throwable) {
    // Fixed synthetic response, no exception arguments or message.
    file_put_contents(getenv('G3_ABORT_MARKER'), 'finished');
    echo 'done';
}
file_put_contents(getenv('G3_ABORT_MARKER'), 'finished');
