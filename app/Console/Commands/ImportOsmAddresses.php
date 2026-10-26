<?php

namespace App\Console\Commands;

use App\Services\Osm\Import\OsmAddressImporter;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;
use Throwable;

class ImportOsmAddresses extends Command
{
    protected $signature = 'osm:import-addresses {file : Saved Overpass JSON with geometry and metadata}
        {--boundary= : Local Polygon/MultiPolygon GeoJSON boundary}
        {--dry-run : Validate without publishing or changing the import journal}
        {--report= : Write a JSON result and skipped-object report}
        {--allow-large-drop : Allow a verified decrease exceeding 20 percent}';

    protected $description = 'Import structured OSM addresses as an atomic local PostGIS snapshot';

    public function handle(OsmAddressImporter $importer): int
    {
        try {
            if (! $this->option('boundary')) {
                $this->error('Required option: --boundary=/path/to/boundary.geojson');

                return self::FAILURE;
            }
            $result = $importer->import($this->argument('file'), $this->option('boundary'), [
                'dry_run' => $this->option('dry-run'), 'allow_large_drop' => $this->option('allow-large-drop'),
            ]);
            $this->info('Status: '.$result['status'].'; import: '.($result['import_id'] ?? 'none'));
            $report = $result['report'];
            $this->table(['Input objects', 'Auxiliary relations', 'Accepted addresses', 'Skipped', 'Warnings'], [[
                $report['input_objects'], $report['auxiliary_relations'], $report['accepted_addresses'], count($report['skipped']), count($report['warnings']),
            ]]);
            if ($report['large_drop']) {
                $this->warn('Address count decreased by more than 20%.');
            }
            if ($path = $this->option('report')) {
                File::ensureDirectoryExists(dirname($path));
                File::put($path, json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)."\n");
                $this->info('Report: '.$path);
            }

            return self::SUCCESS;
        } catch (Throwable $error) {
            $this->error($error->getMessage());

            return self::FAILURE;
        }
    }
}
