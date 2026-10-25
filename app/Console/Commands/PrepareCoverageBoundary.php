<?php

namespace App\Console\Commands;

use App\Services\Gis\DatasetCoverage;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;
use Throwable;

class PrepareCoverageBoundary extends Command
{
    protected $signature = 'gis:prepare-coverage {boundary : Saved service GeoJSON} {output : New selection GeoJSON file} {--buffer-m=1000 : Buffer in metres, EPSG:32646}';

    protected $description = 'Prepare an offline buffered selection boundary without changing the service territory';

    public function handle(DatasetCoverage $coverage): int
    {
        try {
            $output = $this->argument('output');
            if (file_exists($output)) {
                throw new \RuntimeException('Output already exists; refusing to overwrite it.');
            }
            $prepared = $coverage->prepare(File::get($this->argument('boundary')), $this->option('buffer-m'));
            File::ensureDirectoryExists(dirname($output));
            // Exact bytes are part of PBF preparation provenance. Do not add whitespace or a trailing newline.
            File::put($output, $prepared['data_geometry']);
            $this->line(json_encode($coverage->metadata($prepared), JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));

            return self::SUCCESS;
        } catch (Throwable $error) {
            $this->error($error->getMessage());

            return self::FAILURE;
        }
    }
}
