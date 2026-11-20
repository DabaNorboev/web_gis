<?php

return [
    // Deliberately inactive until deployment/plan/attribution checks in G5.
    'enabled' => env('GEOCODING_ENABLED', false),
    'api_key' => env('GEOAPIFY_API_KEY', ''),
    'daily_limit' => env('GEOAPIFY_DAILY_LIMIT', 2000),
    'scope_id' => 'krasnoyarsk-2026-10-07',
    'scope_path' => base_path('data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson'),
    'scope_sha256' => '0a631518e68855b2eba44a72429b9a11fa95e0de075c013f523eafa4b84ef5f8',
];
