<?php

namespace App\Console\Commands;

use App\Services\Gis\DatasetCoverage;
use App\Services\Osm\Import\OsmGroceryImporter;
use App\Services\Osm\Import\OsmKindergartenPreparation;
use App\Services\Osm\Import\OsmKindergartenReader;
use App\Services\Osm\Import\OsmSchoolPreparation;
use App\Services\Osm\Import\OsmSchoolReader;
use Illuminate\Console\Command;
use Throwable;

class ImportOsmEducation extends Command
{
    protected $signature = 'osm:import-education {category} {file} {--boundary=} {--expected-sha256=}';

    protected $description = 'Activate one prepared OSM school or kindergarten snapshot';

    public function handle(DatasetCoverage $coverage): int
    {
        $category = $this->argument('category');
        $boundary = $this->option('boundary');
        if (! in_array($category, ['school', 'kindergarten'], true) || ! $boundary) {
            $this->error('Choose school or kindergarten and provide --boundary for the target database.');

            return self::FAILURE;
        }

        try {
            $importer = $category === 'school'
                ? new OsmGroceryImporter(app(OsmSchoolReader::class), $coverage, app(OsmSchoolPreparation::class))
                : new OsmGroceryImporter(app(OsmKindergartenReader::class), $coverage, app(OsmKindergartenPreparation::class));
            $result = $importer->import($this->argument('file'), $boundary, ['expected_sha256' => $this->option('expected-sha256')]);
            $this->line(json_encode($result, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));

            return self::SUCCESS;
        } catch (Throwable $error) {
            $this->error($error->getMessage());

            return self::FAILURE;
        }
    }
}
