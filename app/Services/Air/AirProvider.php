<?php

namespace App\Services\Air;

use Carbon\CarbonImmutable;
use DateTimeImmutable;
use DateTimeZone;
use JsonException;
use RuntimeException;

class AirProvider
{
    private const SOURCE = 'air.krasn.ru/project/9';

    private const A11_INPUT = '653e4e965868012260a6f2ca35f2cf7bae14fdab4f460b80005188b8d864ea82';

    private const A11_CATALOG = 'af9dbf67d2065b408d4fcc9c496a5b1b59acbf9eab28e4bfde09fe000a187451';

    private const STATION_CATALOG = 'raw/air-project9-api.json';

    private const A11_POSITIONS = [
        '3846' => [92.910795, 56.024966],
        '3858' => [92.97329, 56.01204],
        '4228' => [92.943622, 56.022003],
    ];

    public function __construct(private AirStationDistances $distances) {}

    public function analyze(array $selectedIds, array $point): array
    {
        $release = $this->read();
        $message = $release === null
            ? 'Проверенный локальный выпуск наблюдений недоступен.'
            : 'Полнота сети и актуальность наблюдений неизвестны.';
        $data = null;
        if ($release !== null) {
            $stations = [];
            foreach ($release['stations'] as $station) {
                $id = $station['station_id'];
                $coverage = $release['coverage'][$id];
                $selected = in_array($id, $selectedIds, true);
                $stations[] = [
                    'id' => $id, 'name' => $station['name'], 'source' => self::SOURCE,
                    'selected' => $selected, 'group' => $selected ? 'selected' : 'unlocated',
                    'status' => 'UNKNOWN',
                    'history' => [
                        'status' => $coverage['row_count'] ? 'AVAILABLE' : 'UNAVAILABLE',
                        'first_observed_at_raw' => $coverage['first_observed_at_raw'],
                        'last_observed_at_raw' => $coverage['last_observed_at_raw'],
                        'row_count' => $coverage['row_count'], 'null_values' => $coverage['null_values'],
                        'missing_hour_bins' => $coverage['missing_hour_bins'],
                        'reason' => $coverage['row_count'] ? null : 'SOURCE_ROW_MISSING',
                    ],
                    'latest' => $release['latest'][$id] ?? null,
                ] + $this->mapPosition($station, $release['a11_catalog']);
            }
            $stations = $this->distances->nearestFirst($stations, $point);
            $ids = array_column($stations, 'id');
            $found = array_intersect($selectedIds, $ids);
            $data = $this->metadata($release) + [
                'stations' => $stations, 'missing_selected_ids' => array_values(array_diff($selectedIds, $ids)),
                'counts' => ['selected' => count($found), 'unlocated' => count($stations) - count($found)],
            ];
        }

        return [
            'status' => $data === null ? 'UNAVAILABLE' : 'READY',
            'code' => $data === null ? 'AIR_SOURCE_UNAVAILABLE' : null,
            'message' => $data === null ? $message : null,
            'data' => $data, 'coverage' => null, 'completeness' => ['status' => 'UNKNOWN', 'reason' => $message],
            'calculated_at' => CarbonImmutable::now('UTC')->toISOString(),
        ];
    }

    private function mapPosition(array $station, bool $a11Catalog): array
    {
        $id = $station['station_id'];
        $position = [$station['lon'] ?? null, $station['lat'] ?? null];
        if ($a11Catalog && $position === (self::A11_POSITIONS[$id] ?? null)
            && ($station['source'] ?? null) === self::SOURCE
            && ($station['coordinate_source'] ?? null) === self::STATION_CATALOG
            && ($station['coordinate_source_id'] ?? null) === (int) $id) {
            return [
                'lon' => $position[0], 'lat' => $position[1], 'crs' => 'EPSG:4326',
                'coordinate_reason' => 'A11_OPERATOR_MAP_INTERPRETATION',
                'coordinate_provenance' => ['raw_file' => self::STATION_CATALOG, 'source_id' => $id],
            ];
        }

        return ['lon' => null, 'lat' => null, 'crs' => null, 'coordinate_reason' => 'SOURCE_DATUM_CRS_UNCONFIRMED'];
    }

    private function hasA11Catalog(string $folder, array $manifest, array $inventory): bool
    {
        $path = 'input/'.self::STATION_CATALOG;
        if (($manifest['input_manifest_sha256'] ?? null) !== self::A11_INPUT
            || ($inventory[$path]['sha256'] ?? null) !== self::A11_CATALOG) {
            return false;
        }

        try {
            return hash('sha256', $this->file($folder.'/'.$path, 8192)) === self::A11_CATALOG;
        } catch (RuntimeException) {
            return false;
        }
    }

    public function history(string $version, string $id): array
    {
        $release = $this->read($version, $id);
        if ($release === null) {
            return ['code' => 'AIR_SOURCE_UNAVAILABLE'];
        }
        if ($release['snapshot_version'] !== $version) {
            return ['code' => 'AIR_SNAPSHOT_CHANGED'];
        }
        if (! isset($release['coverage'][$id])) {
            return ['code' => 'AIR_STATION_NOT_FOUND'];
        }

        $rows = [];
        $window = $release['window_raw'];
        $end = $this->sourceHour($window['end_exclusive']);
        for ($hour = $this->sourceHour($window['begin_inclusive']); $hour < $end; $hour = $hour->modify('+1 hour')) {
            $time = $hour->format('Y-m-d H:i:s');
            $rows[] = $release['series'][$time] ?? $this->observation($time, null, false);
        }

        return $this->metadata($release) + ['station_id' => $id, 'source' => self::SOURCE, 'rows' => $rows];
    }

    private function metadata(array $release): array
    {
        return [
            'snapshot_version' => $release['snapshot_version'], 'window_raw' => $release['window_raw'],
            'last_success_at' => $release['last_success_at'], 'last_observed_at_raw' => $release['last_observed_at_raw'],
            'timezone' => null, 'utc_offset' => null, 'time_reason' => 'SOURCE_TIMEZONE_UNCONFIRMED',
            'freshness' => 'UNKNOWN', 'scope' => 'STATION_OBSERVATIONS',
            'indicator' => 'pm2_5', 'unit' => 'µg/m³', 'aggregation' => 'hourly',
        ];
    }

    private function observation(string $time, int|float|null $value, bool $present): array
    {
        return [
            'observed_at_raw' => $time, 'observed_at_utc' => null, 'value' => $value, 'row_present' => $present,
            'missing_reason' => $present ? ($value === null ? 'SOURCE_VALUE_NULL_OR_ABSENT' : null) : 'SOURCE_ROW_MISSING',
            'qc' => 'UNKNOWN', 'qc_reason' => $present ? 'SOURCE_QC_NOT_PROVIDED' : 'SOURCE_ROW_MISSING',
        ];
    }

    private function read(?string $version = null, ?string $stationId = null): ?array
    {
        $root = config('air.root');
        if (! is_string($root) || ! str_starts_with($root, '/')) {
            return null;
        }
        $lock = @fopen($root.'/.publish.lock', 'rb');
        if ($lock === false) {
            return null;
        }

        try {
            if (! flock($lock, LOCK_SH)) {
                return null;
            }
            $active = $this->json($this->file($root.'/active.json', 4096));
            $pin = $active['snapshot_version'] ?? '';
            $lastSuccess = $active['last_success_at'] ?? null;
            $lastObserved = $active['last_observed_at_raw'] ?? null;
            if (! is_string($pin) || ! preg_match('/\A[a-f0-9]{64}\z/', $pin)
                || ! is_string($lastSuccess) || ! preg_match('/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\z/', $lastSuccess)
                || ! array_key_exists('last_observed_at_raw', $active) || ($lastObserved !== null && ! is_string($lastObserved))) {
                return null;
            }
            $folder = $root.'/releases/'.$pin;
            if (is_link($folder)) {
                return null;
            }
            $body = $this->file($folder.'/manifest.json', 65536);
            if (! hash_equals($pin, hash('sha256', $body))) {
                return null;
            }
            $manifest = $this->json($body);
            if (($manifest['schema'] ?? null) !== 'placelens.air-snapshot.v1' || ($manifest['state'] ?? null) !== 'ready'
                || ! is_array($manifest['files'] ?? null) || ! is_array($manifest['window_raw'] ?? null)) {
                return null;
            }
            if ($version !== null && $version !== $pin) {
                return ['snapshot_version' => $pin];
            }
            $inventory = array_column($manifest['files'], null, 'path');
            // Only the pinned A11 input and catalog carry the owner-approved interpretation.
            $a11Catalog = $stationId === null && $this->hasA11Catalog($folder, $manifest, $inventory);
            $metadata = [];
            foreach (['stations.json' => 65536, 'coverage.json' => 65536, 'observations.jsonl' => 8 * 1024 * 1024] as $name => $limit) {
                $product = $this->file($folder.'/'.$name, $limit);
                $entry = $inventory[$name] ?? [];
                if (strlen($product) !== ($entry['bytes'] ?? null) || hash('sha256', $product) !== ($entry['sha256'] ?? null)) {
                    return null;
                }
                $metadata[$name] = $product;
            }
        } catch (JsonException|RuntimeException) {
            return null;
        } finally {
            fclose($lock);
        }

        // The publisher verifies all input and output files before activation.
        // The reader verifies its own bytes while holding the publication lock.
        try {
            $window = $manifest['window_raw'];
            $hours = ($this->sourceHour($window['end_exclusive'])->getTimestamp() - $this->sourceHour($window['begin_inclusive'])->getTimestamp()) / 3600;
            if ($hours < 1 || $hours > 168) {
                return null;
            }
            $stations = $this->json($metadata['stations.json']);
            $coverage = array_column($this->json($metadata['coverage.json']), null, 'station_id');
            $observationTimes = array_filter(array_column($coverage, 'last_observed_at_raw'), 'is_string');
            if ($lastObserved !== ($observationTimes === [] ? null : max($observationTimes))) {
                return null;
            }
            $latest = $series = [];
            foreach (explode("\n", rtrim($metadata['observations.jsonl'], "\n")) as $line) {
                if ($line === '') {
                    continue;
                }
                $raw = $this->json($line);
                $id = $raw['station_id'];
                if ($stationId !== null && $stationId !== $id) {
                    continue;
                }
                $time = $raw['observed_at_raw'];
                $row = $this->observation($time, $raw['value'], true);
                $latest[$id] = $row; // A11 sorts observations by station and literal hour.
                if ($stationId !== null) {
                    $series[$time] = $row;
                }
            }

            return [
                'snapshot_version' => $pin, 'last_success_at' => $lastSuccess, 'last_observed_at_raw' => $lastObserved,
                'a11_catalog' => $a11Catalog,
                'window_raw' => $window, 'stations' => $stations, 'coverage' => $coverage, 'latest' => $latest, 'series' => $series,
            ];
        } catch (JsonException|RuntimeException) {
            return null;
        }
    }

    private function sourceHour(string $literal): DateTimeImmutable
    {
        // Use a zone without DST only for calendar arithmetic. The source literal is never converted.
        $hour = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $literal, new DateTimeZone('UTC'));
        if ($hour === false || $hour->format('Y-m-d H:00:00') !== $literal) {
            throw new RuntimeException('Invalid air snapshot window.');
        }

        return $hour;
    }

    private function file(string $path, int $limit): string
    {
        if (! is_file($path) || is_link($path)) {
            throw new RuntimeException('Air snapshot file unavailable.');
        }
        $body = @file_get_contents($path, false, null, 0, $limit + 1);
        if ($body === false || strlen($body) > $limit) {
            throw new RuntimeException('Air snapshot file unavailable.');
        }

        return $body;
    }

    private function json(string $body): array
    {
        $value = json_decode($body, true, 64, JSON_THROW_ON_ERROR);
        if (! is_array($value)) {
            throw new RuntimeException('Invalid air snapshot JSON.');
        }

        return $value;
    }
}
