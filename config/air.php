<?php

return [
    'root' => env('AIR_SNAPSHOT_ROOT'),
    'stations' => env('AIR_STATION_IDS'),
    'window_hours' => env('AIR_WINDOW_HOURS'),
    'window_timezone' => env('AIR_WINDOW_TIMEZONE'),
    'retention_days' => env('AIR_RETENTION_DAYS'),
    'schedule_enabled' => (bool) env('AIR_SCHEDULE_ENABLED', false),
    'schedule_cron' => env('AIR_SCHEDULE_CRON'),
];
