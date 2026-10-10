<?php

namespace App\Services\Transport\Import;

use DateTimeImmutable;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Throwable;

class OfficialStopsImporter
{
    public const SOURCE = '24bpd';

    public const DATASET = 'transport_stops:krasnoyarsk';

    public function __construct(
        private OfficialStopsCsvReader $reader,
        private OfficialRouteNormalizer $normalizer,
        private GeoJsonBoundary $boundary,
    ) {}

    public function import(string $file, string $boundaryFile, array $options = []): array
    {
        if (DB::getDriverName() !== 'pgsql') {
            throw new RuntimeException('Transport import requires PostgreSQL/PostGIS.');
        }
        $contents = $this->readFile($file);
        $boundaryContents = $this->readFile($boundaryFile);
        $configuration = [
            'importer_version' => 2,
            'route_catalog' => $this->normalizer->catalogMetadata(),
            'boundary_sha256' => hash('sha256', $boundaryContents),
            'source_version' => $options['source_version'] ?? null,
            'source_updated_at' => $this->date($options['source_updated_at'] ?? null),
            'observed_at' => $this->date($options['observed_at'] ?? null),
        ];
        $identity = [
            'source' => self::SOURCE,
            'dataset_key' => self::DATASET,
            'checksum_sha256' => hash('sha256', $contents),
            'configuration_sha256' => hash('sha256', $this->json($configuration)),
        ];
        $lock = 'web_gis:'.self::SOURCE.':'.self::DATASET;
        if (! DB::selectOne('SELECT pg_try_advisory_lock(hashtextextended(?, 0)) AS acquired', [$lock])->acquired) {
            throw new RuntimeException('Another transport import is already running.');
        }
        $importId = null;
        $report = [];
        try {
            if (! ($options['dry_run'] ?? false)) {
                $existing = DB::table('dataset_imports')->where($identity)->where('status', 'succeeded')->first();
                if ($existing) {
                    return ['status' => 'skipped', 'import_id' => $existing->id, 'report' => json_decode($existing->result, true)];
                }
                $importId = DB::table('dataset_imports')->insertGetId($identity + [
                    'source_url' => 'https://www.24bpd.ru/opendata/2466231215-stoppingpoints/',
                    'source_version' => $configuration['source_version'],
                    'source_updated_at' => $configuration['source_updated_at'],
                    'observed_at' => $configuration['observed_at'],
                    'configuration' => $this->json($configuration),
                    'status' => 'running',
                ]);
            }

            // Preparation and publication share a transaction; failed SQL cannot poison the failure audit update.
            return DB::transaction(function () use ($contents, $boundaryContents, $options, $importId, &$report) {
                $rows = $this->reader->read($contents);
                $valid = array_values(array_filter($rows, fn ($r) => $r['lon'] !== null && $r['lat'] !== null));
                $selected = $this->boundary->select($valid, $this->boundary->geometry($boundaryContents));
                $report = [
                    'input_rows' => count($rows), 'accepted_stops' => count($selected),
                    'outside_boundary' => count($valid) - count($selected),
                    'invalid_coordinates' => array_values(array_column(array_filter($rows, fn ($r) => $r['lon'] === null || $r['lat'] === null), 'source_id')),
                    'routes' => 0, 'stop_route_links' => 0, 'unknown_routes' => 0, 'warnings' => [],
                ];
                if (! $selected) {
                    throw new RuntimeException('No stops inside the boundary; empty snapshots cannot be published.');
                }
                $routes = [];
                foreach ($selected as &$stop) {
                    $normalized = $this->normalizer->normalize($stop['raw']['num_route'], $stop['raw']['type_transport']);
                    $stop['routes'] = array_column($normalized['routes'], 'source_id');
                    if ($normalized['issues']) {
                        $report['warnings'][] = ['source_id' => $stop['source_id'], 'issues' => $normalized['issues']];
                    }
                    foreach ($normalized['routes'] as $route) {
                        $key = $route['source_id'];
                        $routes[$key] ??= $route;
                        $routes[$key]['resolutions'] = array_values(array_unique(array_merge($routes[$key]['resolutions'], $route['resolutions']), SORT_REGULAR));
                        $routes[$key]['raw_tokens'] = array_values(array_unique(array_merge($routes[$key]['raw_tokens'], $route['raw_tokens'])));
                    }
                    $report['stop_route_links'] += count($stop['routes']);
                }
                unset($stop);
                $report['routes'] = count($routes);
                $report['unknown_routes'] = count(array_filter($routes, fn ($r) => $r['mode'] === 'unknown'));
                $previous = DB::table('dataset_imports')->where('source', self::SOURCE)->where('dataset_key', self::DATASET)->where('is_active', true)->first();
                $report['large_drop'] = $previous && count($selected) < $previous->row_count * 0.8;
                if ($options['dry_run'] ?? false) {
                    return ['status' => 'dry-run', 'import_id' => null, 'report' => $report];
                }
                if ($report['large_drop'] && ! ($options['allow_large_drop'] ?? false)) {
                    throw new RuntimeException('Stop count decreased by more than 20%; inspect --dry-run before using --allow-large-drop.');
                }
                $routeIds = [];
                foreach ($routes as $key => $route) {
                    $routeIds[$key] = DB::table('transport_routes')->insertGetId([
                        'dataset_import_id' => $importId, 'source_id' => $key,
                        'mode' => $route['mode'], 'ref' => $route['ref'],
                        'raw_data' => $this->json(['raw_tokens' => $route['raw_tokens'], 'resolutions' => $route['resolutions']]),
                    ]);
                }
                foreach ($selected as $stop) {
                    $id = DB::selectOne(<<<'SQL'
                        INSERT INTO transport_stops (dataset_import_id, source_id, name, address, geom, raw_data)
                        VALUES (?, ?, ?, ?, ST_SetSRID(ST_MakePoint(?, ?), 4326), ?::jsonb) RETURNING id
                        SQL, [$importId, $stop['source_id'], trim($stop['raw']['name']) ?: null,
                        trim($stop['raw']['address']) ?: null, $stop['lon'], $stop['lat'], $this->json($stop['raw'])])->id;
                    $links = array_map(fn ($key) => ['dataset_import_id' => $importId, 'transport_stop_id' => $id, 'transport_route_id' => $routeIds[$key]], $stop['routes']);
                    if ($links) {
                        DB::table('transport_stop_routes')->insert($links);
                    }
                }
                DB::table('dataset_imports')->where('source', self::SOURCE)->where('dataset_key', self::DATASET)->where('is_active', true)->update(['is_active' => false]);
                DB::table('dataset_imports')->where('id', $importId)->update([
                    'status' => 'succeeded', 'is_active' => true, 'finished_at' => DB::raw('GREATEST(started_at, clock_timestamp())'),
                    'row_count' => count($selected), 'result' => $this->json($report),
                ]);

                return ['status' => 'succeeded', 'import_id' => $importId, 'report' => $report];
            });
        } catch (Throwable $error) {
            if ($importId !== null) {
                DB::table('dataset_imports')->where('id', $importId)->update([
                    'status' => 'failed', 'finished_at' => DB::raw('GREATEST(started_at, clock_timestamp())'), 'result' => $this->json($report),
                    'error_message' => $error->getMessage(),
                ]);
            }
            throw $error;
        } finally {
            DB::selectOne('SELECT pg_advisory_unlock(hashtextextended(?, 0))', [$lock]);
        }
    }

    private function readFile(string $path): string
    {
        if (! is_file($path) || ! is_readable($path)) {
            throw new RuntimeException('Not a readable local file: '.$path);
        }
        $contents = file_get_contents($path);
        if ($contents === false) {
            throw new RuntimeException('Cannot read file: '.$path);
        }

        return $contents;
    }

    private function date(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }
        if (! preg_match('/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2}))?$/', $value)) {
            throw new RuntimeException('Use YYYY-MM-DD or an ISO 8601 timestamp with timezone.');
        }
        $date = new DateTimeImmutable(strlen($value) === 10 ? $value.'T00:00:00Z' : $value);
        $errors = DateTimeImmutable::getLastErrors();
        if ($errors && ($errors['warning_count'] || $errors['error_count'])) {
            throw new RuntimeException('Invalid source date: '.$value);
        }

        return $date->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
    }

    private function json(array $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    }
}
