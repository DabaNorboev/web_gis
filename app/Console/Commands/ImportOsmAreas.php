<?php

namespace App\Console\Commands;

use App\Services\Osm\Import\OsmAreaDataset;
use App\Services\Osm\Import\OsmAreaImporter;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;
use Throwable;

class ImportOsmAreas extends Command
{
    protected $signature = 'osm:import-areas {dataset : green_areas or water} {file : Saved OSM JSON with complete polygon members}
        {--boundary= : Local Polygon/MultiPolygon GeoJSON boundary}
        {--buffer-m=0 : Data selection buffer outside the service boundary, in metres}
        {--source-url= : Recorded HTTP(S) source URL; no network request}
        {--expected-sha256= : Require the verified snapshot checksum}
        {--dry-run : Validate without changing published data or the import journal}
        {--report= : Write a JSON report}
        {--allow-large-drop : Allow a verified decrease exceeding 20 percent}';

    protected $description = 'Import offline OSM green areas or water polygons as separate atomic snapshots';

    public function handle(OsmAreaImporter $importer): int
    {
        try {
            $dataset = OsmAreaDataset::tryFrom($this->argument('dataset'));
            if (! $dataset || ! $this->option('boundary')) {
                $this->error('Choose green_areas or water and provide --boundary=/path/to/boundary.geojson');

                return self::FAILURE;
            }
            $options = array_filter([
                'buffer_m' => $this->option('buffer-m'),
                'dry_run' => $this->option('dry-run'), 'allow_large_drop' => $this->option('allow-large-drop'),
                'source_url' => $this->option('source-url'), 'expected_sha256' => $this->option('expected-sha256'),
            ], fn ($v) => $v !== null);
            $result = $importer->import($dataset, $this->argument('file'), $this->option('boundary'), $options);
            $this->info('Status: '.$result['status'].'; import: '.($result['import_id'] ?? 'none'));
            $r = $result['report'];
            $this->table(['Dataset', 'Input', 'Not selected', 'Accepted', 'Skipped', 'Warnings'], [[
                $dataset->value, $r['input_objects'], $r['not_selected'], $r['accepted_objects'], count($r['skipped']), count($r['warnings']),
            ]]);
            if ($r['large_drop']) {
                $this->warn('Object count decreased by more than 20%.');
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
