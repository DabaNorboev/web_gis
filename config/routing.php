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
    'walking' => [
        'version' => 'ors-foot-20261026-v1',
        'manifest_sha256' => 'c448c4c1625e4bc514347d03ede7d364ba04d1af536f8a25e91d347b34a6a6a7',
        'snapshot_path' => base_path('data/prepared/local-routing/ors-foot-20261026-v1'),
        'url' => 'http://local-walking:8082/ors/v2',
        'connect_timeout_s' => .5,
        'timeout_s' => 3,
        'max_response_bytes' => 2_000_000,
        'max_route_distance_m' => 10_000,
    ],
];
