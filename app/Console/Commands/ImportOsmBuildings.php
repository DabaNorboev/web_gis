<?php

namespace App\Console\Commands;

use App\Services\Osm\Import\OsmBuildingImporter;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;
use Throwable;

class ImportOsmBuildings extends Command
{
    protected $signature = 'osm:import-buildings {file : Saved Overpass JSON with complete geometry}
        {--boundary= : Local Polygon/MultiPolygon GeoJSON boundary}
        {--source-url= : Recorded HTTP(S) source URL; no network request}
        {--expected-sha256= : Require the verified snapshot checksum}
        {--dry-run : Validate without publishing or changing the import journal}
        {--report= : Write a JSON report}
        {--allow-large-drop : Allow a verified decrease exceeding 20 percent}';

    protected $description = 'Import OSM buildings and parts as an atomic offline PostGIS snapshot';

    public function handle(OsmBuildingImporter $importer): int
    {
        try {
            if (! $this->option('boundary')) {
                $this->error('Required option: --boundary=/path/to/boundary.geojson');

                return self::FAILURE;
            }
            $options = array_filter([
                'dry_run' => $this->option('dry-run'), 'allow_large_drop' => $this->option('allow-large-drop'),
                'source_url' => $this->option('source-url'), 'expected_sha256' => $this->option('expected-sha256'),
            ], fn ($value) => $value !== null);
            $result = $importer->import($this->argument('file'), $this->option('boundary'), $options);
            $this->info('Status: '.$result['status'].'; import: '.($result['import_id'] ?? 'none'));
            $r = $result['report'];
            $this->table(['Input', 'Stored', 'Building contours', 'Parts', 'Independent OSM buildings', 'Skipped'], [[
                $r['input_objects'], $r['accepted_objects'], $r['buildings'], $r['parts'], $r['independent_building_objects'], count($r['skipped']),
            ]]);
            if ($r['large_drop']) {
                $this->warn('Building objects or independent buildings decreased by more than 20%.');
            }
            if ($path = $this->option('report')) {
                File::ensureDirectoryExists(dirname($path));
                File::put($path, json_encode($result, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)."\n");
            }

            return self::SUCCESS;
        } catch (Throwable $error) {
            $this->error($error->getMessage());

            return self::FAILURE;
        }
    }
}
