<?php

namespace Tests\Support;

use Illuminate\Database\Connection;
use Illuminate\Support\Facades\DB;
use RuntimeException;

final class PostgisDatabase
{
    public static function assertConfiguration(array $configuration): void
    {
        if (($configuration['driver'] ?? null) !== 'pgsql'
            || ($configuration['database'] ?? null) !== 'web_gis_test'
            || ! empty($configuration['url'])
            || isset($configuration['read']) || isset($configuration['write'])) {
            throw new RuntimeException('PostGIS tests require a direct pgsql connection to web_gis_test without DB_URL or read/write hosts.');
        }
    }

    public static function assertDatabase(string $database): void
    {
        if ($database !== 'web_gis_test') {
            throw new RuntimeException('PostGIS tests connected to a database other than web_gis_test.');
        }
    }

    public static function assertMode(object $state, bool $readOnly): void
    {
        $expected = $readOnly ? 'on' : 'off';
        if ($state->read_only !== $expected || $state->default_read_only !== $expected) {
            throw new RuntimeException('PostGIS tests require transaction and session READ ONLY '.$expected.'.');
        }
    }

    public static function connect(bool $readOnly): Connection
    {
        $name = config('database.default');
        // Reject unsafe configuration before opening a connection, including cached app config.
        self::assertConfiguration(config('database.connections.'.$name, []));
        $connection = DB::connection($name);
        self::assertDatabase($connection->selectOne('SELECT current_database() AS name')->name);

        if ($readOnly) {
            // This session belongs only to this test. Never change database/role defaults.
            $connection->statement('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
        }
        // Writable tests fail closed when the environment is read-only; never force READ WRITE.
        self::assertMode($connection->selectOne("SELECT current_setting('transaction_read_only') AS read_only,
            current_setting('default_transaction_read_only') AS default_read_only"), $readOnly);

        return $connection;
    }
}
