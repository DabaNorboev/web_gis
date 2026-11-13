<?php

use App\Services\Analysis\SatelliteProvider;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Tests\Support\PostgisDatabase;

$ioStart = file_get_contents('/proc/self/io');
preg_match('/rchar: (\d+)/', $ioStart, $initialIo);
$initialChars = (int) ($initialIo[1] ?? 0);

// Test-only real HTTP process. Never used by production routes.
require __DIR__.'/../../vendor/autoload.php';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
PostgisDatabase::connect(true);
$app->bind(SatelliteProvider::class, fn () => new class extends SatelliteProvider
{
    protected function read(array $point, int $radius): array
    {
        $r = parent::read($point, $radius);
        $GLOBALS['satellite_metrics'] = $r['metrics'] ?? null;

        return $r;
    }
});
register_shutdown_function(function () use ($initialChars) {
    $io = file_get_contents('/proc/self/io');
    preg_match('/rchar: (\d+)/', $io, $m);
    file_put_contents(getenv('SATELLITE_HTTP_METRICS'), json_encode(['reader' => $GLOBALS['satellite_metrics'] ?? null,
        'peak_PHP_bytes' => memory_get_peak_usage(true), 'RSS_KiB' => getrusage()['ru_maxrss'], 'request_rchar' => (int) ($m[1] ?? 0) - $initialChars])."\n", FILE_APPEND);
});
$app->handleRequest(Request::capture());
