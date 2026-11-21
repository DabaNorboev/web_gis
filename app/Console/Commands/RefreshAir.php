<?php

namespace App\Console\Commands;

use Carbon\CarbonImmutable;
use DateTimeZone;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Process;
use Throwable;

class RefreshAir extends Command
{
    protected $signature = 'air:refresh {--end= : Exclusive end in source time (YYYY-MM-DD HH:00:00)}';

    protected $description = 'Refresh the local air snapshot for one bounded window';

    public function handle(): int
    {
        $root = config('air.root');
        $stations = config('air.stations');
        $hours = filter_var(config('air.window_hours'), FILTER_VALIDATE_INT);
        $retention = filter_var(config('air.retention_days'), FILTER_VALIDATE_INT);
        if (! is_string($root) || ! str_starts_with($root, '/') || ! is_string($stations)
            || ! preg_match('/\A[1-9][0-9]{0,15}(?:,[1-9][0-9]{0,15}){0,19}\z/', $stations)
            || $hours < 1 || $hours > 168 || $retention < 1 || $retention > 3650) {
            $this->error('Configure the air snapshot root, station IDs, window and retention first.');

            return self::FAILURE;
        }

        try {
            $end = $this->option('end');
            if ($end === null) {
                $timezone = config('air.window_timezone');
                if (! is_string($timezone) || ! in_array($timezone, DateTimeZone::listIdentifiers(DateTimeZone::ALL_WITH_BC), true)) {
                    $this->error('Specify the source window timezone or an explicit --end.');

                    return self::FAILURE;
                }
                $end = CarbonImmutable::now($timezone)->startOfHour()->format('Y-m-d H:i:s');
            }

            $result = Process::timeout(45)->run(['python3', '-B', base_path('scripts/air/refresh.py'),
                '--root', $root, '--stations', $stations, '--end', $end,
                '--hours', (string) $hours, '--retention-days', (string) $retention]);

            if ($result->successful() && trim($result->output()) === 'older_window') {
                $this->info('Air refresh skipped: requested window ends before the active snapshot.');

                return self::SUCCESS;
            }

            if ($result->successful() && in_array(trim($result->output()), ['ready', 'busy'], true)) {
                $this->info(trim($result->output()) === 'ready' ? 'Air snapshot verified.' : 'Air refresh already running.');
                if ($result->errorOutput() !== '') {
                    $this->warn('Air snapshot retention cleanup incomplete.');
                }

                return self::SUCCESS;
            }
        } catch (Throwable) {
            // Process failures can contain environment-specific paths or parameters.
        }

        $this->error('Air refresh failed. Check the configured source window and local snapshot storage.');

        return self::FAILURE;
    }
}
