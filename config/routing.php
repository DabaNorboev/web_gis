<?php

return [
    'version' => 'osrm-car-20261021-v1',
    'manifest_sha256' => 'cd62979bb110e446addd6c4221e731990b7e553a679a85921562b9ed557683cc',
    'snapshot_path' => base_path('data/prepared/local-routing/osrm-car-20261021-v1'),
    // A fixed internal hostname; no request parameter can choose another router.
    'url' => 'http://local-router:5000',
    'connect_timeout_s' => .5,
    'timeout_s' => 1.5,
    'max_response_bytes' => 1_000_000,
    'max_route_distance_m' => 40_000,
];
