<?php

use App\Services\Satellite\SatelliteCatalogReader;

// Explicit CLI for native public/synthetic QA. Does not bootstrap Laravel or access a database.
require __DIR__.'/../vendor/autoload.php';
$options = getopt('', ['runtime:', 'sha256:', 'x:', 'y:', 'radius:']);
if (count($options) !== 5 || ! is_numeric($options['x']) || ! is_numeric($options['y']) || ! ctype_digit($options['radius'])) {
    fwrite(STDERR, "Required: --runtime --sha256 --x --y --radius (EPSG:32646 metres)\n");
    exit(1);
}
try {
    $reader = new SatelliteCatalogReader($options['runtime'], $options['sha256']);
    echo json_encode($reader->forProjectedPoint((float) $options['x'], (float) $options['y'], (int) $options['radius']), JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)."\n";
} catch (Throwable $e) {
    fwrite(STDERR, get_class($e).': '.$e->getMessage()."\n");
    exit(1);
}
