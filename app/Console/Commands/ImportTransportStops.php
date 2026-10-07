<?php

namespace App\Console\Commands;

use App\Services\Transport\Import\OfficialStopsImporter;
use Illuminate\Console\Command;
use Throwable;

class ImportTransportStops extends Command
{
    protected $signature = 'transport:import-stops {file : Local official CSV file}
        {--boundary= : Local Krasnoyarsk GeoJSON boundary}
        {--source-version= : Source file version}
        {--source-updated-at= : Source publication date, distinct from observation date}
        {--observed-at= : Observation date, only if known}
        {--dry-run : Validate and report without writing data}
        {--allow-large-drop : Allow a verified decrease exceeding 20 percent}';

    protected $description = 'Import official Krasnoyarsk stops as an atomic PostGIS snapshot';

    public function handle(OfficialStopsImporter $importer): int
    {
        try {
            if (! $this->option('boundary')) {
                $this->error('Required option: --boundary=/path/to/boundary.geojson');

                return self::FAILURE;
            }
            $result = $importer->import($this->argument('file'), $this->option('boundary'), [
                'source_version' => $this->option('source-version'),
                'source_updated_at' => $this->option('source-updated-at'),
                'observed_at' => $this->option('observed-at'),
                'dry_run' => $this->option('dry-run'),
                'allow_large_drop' => $this->option('allow-large-drop'),
            ]);
            $this->info('Status: '.$result['status'].'; import: '.($result['import_id'] ?? 'none'));
            $report = $result['report'];
            $this->table(['Input', 'Accepted stops', 'Outside', 'Invalid coordinates', 'Routes', 'Links', 'Unknown routes', 'Stops with warnings'], [[
                $report['input_rows'], $report['accepted_stops'], $report['outside_boundary'],
                count($report['invalid_coordinates']), $report['routes'], $report['stop_route_links'],
                $report['unknown_routes'], count($report['warnings']),
            ]]);
            if ($report['large_drop']) {
                $this->warn('Stop count decreased by more than 20%.');
            }
            if ($report['invalid_coordinates']) {
                $this->warn('Invalid coordinate IDs: '.implode(', ', $report['invalid_coordinates']));
            }

            return self::SUCCESS;
        } catch (Throwable $error) {
            $this->error($error->getMessage());

            return self::FAILURE;
        }
    }
}
