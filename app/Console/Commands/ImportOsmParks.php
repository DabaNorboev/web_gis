<?php

namespace App\Console\Commands;

use App\Services\Osm\Import\OsmParkImporter;
use Illuminate\Console\Command;
use Throwable;

class ImportOsmParks extends Command
{
    protected $signature = 'osm:import-parks {file} {--boundary= : Service boundary GeoJSON} {--buffer-m=0} {--expected-sha256=} {--allow-large-drop}';

    protected $description = 'Activate an offline park snapshot atomically in the explicitly configured target database';

    public function handle(OsmParkImporter $importer): int
    {
        if (! $this->option('boundary')) {
            $this->error('Provide --boundary for the explicitly selected target environment.');

            return self::FAILURE;
        }
        try {
            $options = ['buffer_m' => $this->option('buffer-m'), 'allow_large_drop' => $this->option('allow-large-drop')];
            if ($this->option('expected-sha256') !== null) {
                $options['expected_sha256'] = $this->option('expected-sha256');
            }
            $result = $importer->import($this->argument('file'), $this->option('boundary'), $options);
            $this->line(json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));

            return self::SUCCESS;
        } catch (Throwable $error) {
            $this->error($error->getMessage());

            return self::FAILURE;
        }
    }
}
