<?php

return [
    'legend' => json_decode(file_get_contents(__DIR__.'/satellite/legend.json'), true, 32, JSON_THROW_ON_ERROR),
    'runtime' => env('SATELLITE_RUNTIME'),
    'sha256' => env('SATELLITE_RUNTIME_SHA256'),
    'delivery' => env('SATELLITE_DELIVERY'),
    'delivery_sha256' => env('SATELLITE_DELIVERY_SHA256'),
];
