<?php

return [
    // Separate activation from code delivery: the legacy transport API is unaffected.
    'parks_enabled' => env('PLACE_ANALYSIS_PARKS_ENABLED', false),
    'official_stops_enabled' => env('PLACE_ANALYSIS_OFFICIAL_STOPS_ENABLED', false),
];
