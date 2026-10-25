<?php

namespace Tests\Unit;

use Illuminate\Database\Connection;
use Illuminate\Support\Facades\DB;
use Mockery;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\Support\PostgisDatabase;
use Tests\TestCase;

class PostgisDatabaseSafetyTest extends TestCase
{
    public static function unsafeConfigurations(): array
    {
        $safe = ['driver' => 'pgsql', 'database' => 'web_gis_test', 'url' => ''];

        return [
            'working database' => [array_replace($safe, ['database' => 'web_gis'])],
            'another temporary database' => [array_replace($safe, ['database' => 'placelens_linear_layers_test_1'])],
            'wrong driver' => [array_replace($safe, ['driver' => 'sqlite'])],
            'URL override' => [array_replace($safe, ['url' => 'pgsql://synthetic.invalid/other'])],
            'read host override' => [$safe + ['read' => ['host' => 'synthetic.invalid']]],
            'write host override' => [$safe + ['write' => ['host' => 'synthetic.invalid']]],
        ];
    }

    #[DataProvider('unsafeConfigurations')]
    public function test_unsafe_configuration_is_rejected_before_connecting(array $configuration): void
    {
        config(['database.default' => 'unsafe', 'database.connections.unsafe' => $configuration]);
        DB::shouldReceive('connection')->never();

        $this->expectException(RuntimeException::class);
        PostgisDatabase::connect(false);
    }

    public function test_actual_database_name_must_match_even_with_safe_configuration(): void
    {
        config(['database.default' => 'safe', 'database.connections.safe' => [
            'driver' => 'pgsql', 'database' => 'web_gis_test', 'url' => '',
        ]]);
        $connection = Mockery::mock(Connection::class);
        DB::shouldReceive('connection')->once()->with('safe')->andReturn($connection);
        $connection->shouldReceive('selectOne')->once()->with('SELECT current_database() AS name')
            ->andReturn((object) ['name' => 'web_gis']);
        $connection->shouldNotReceive('statement');

        $this->expectException(RuntimeException::class);
        PostgisDatabase::connect(true);
    }

    public static function mismatchedModes(): array
    {
        return [
            'writer on read-only session' => [false, 'on', 'on'],
            'reader on writable session' => [true, 'off', 'off'],
            'reader with writable future transactions' => [true, 'on', 'off'],
            'writer with read-only future transactions' => [false, 'off', 'on'],
        ];
    }

    #[DataProvider('mismatchedModes')]
    public function test_both_transaction_and_session_modes_are_checked(bool $readOnly, string $transaction, string $session): void
    {
        $this->expectException(RuntimeException::class);
        PostgisDatabase::assertMode((object) ['read_only' => $transaction, 'default_read_only' => $session], $readOnly);
    }
}
