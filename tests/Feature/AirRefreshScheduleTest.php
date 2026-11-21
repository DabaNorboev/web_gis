<?php

namespace Tests\Feature;

use Carbon\CarbonImmutable;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\Process;
use Tests\TestCase;

class AirRefreshScheduleTest extends TestCase
{
    public function test_schedule_is_disabled_by_default(): void
    {
        config(['air.schedule_cron' => '17 */2 * * *', 'air.schedule_enabled' => false]);
        $this->app->make(Kernel::class)->all();
        $this->assertSame([], $this->app->make(Schedule::class)->events());
    }

    public function test_utc_schedule_and_manual_end_use_the_same_bounded_refresh_command(): void
    {
        $root = sys_get_temp_dir().'/air-schedule-'.bin2hex(random_bytes(12));
        config([
            'air.schedule_enabled' => true, 'air.schedule_cron' => '17 */2 * * *',
            'air.root' => $root, 'air.stations' => '1001,1002', 'air.window_hours' => 4,
            'air.window_timezone' => 'Asia/Krasnoyarsk', 'air.retention_days' => 7,
        ]);
        $this->app->make(Kernel::class)->all();
        $events = $this->app->make(Schedule::class)->events();
        $this->assertCount(1, $events);
        $event = $events[0];
        $this->assertStringEndsWith(' artisan air:refresh', str_replace("'", '', $event->command));
        $this->travelTo(CarbonImmutable::parse('2026-11-20T02:16:00Z'));
        $this->assertFalse($event->isDue($this->app));
        $this->travel(1)->minute();
        $this->assertTrue($event->isDue($this->app));

        Process::fake([
            '*' => Process::sequence()->push('ready')->push('busy')->push('older_window')
                ->push(Process::result(exitCode: 1)),
        ]);
        $this->artisan('air:refresh')->expectsOutput('Air snapshot verified.')->assertSuccessful();
        $this->artisan('air:refresh', ['--end' => '2026-08-09 04:00:00'])
            ->expectsOutput('Air refresh already running.')->assertSuccessful();
        $this->artisan('air:refresh', ['--end' => '2026-08-09 04:00:00'])
            ->expectsOutput('Air refresh skipped: requested window ends before the active snapshot.')->assertSuccessful();
        $this->artisan('air:refresh')->assertFailed();

        foreach (['2026-11-20 09:00:00', '2026-08-09 04:00:00'] as $end) {
            Process::assertRan(fn ($process) => $process->timeout === 45 && $process->command === [
                'python3', '-B', base_path('scripts/air/refresh.py'), '--root', $root,
                '--stations', '1001,1002', '--end', $end, '--hours', '4', '--retention-days', '7',
            ]);
        }

        $this->travel(1)->minute();
        $this->assertFalse($event->isDue($this->app));
        $this->assertDirectoryDoesNotExist($root);
    }
}
