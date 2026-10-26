<?php

namespace Tests;

use Illuminate\Support\Facades\DB;
use Tests\Support\PostgisDatabase;

abstract class PostgisTestCase extends TestCase
{
    protected const READ_ONLY = false;

    protected function setUp(): void
    {
        parent::setUp();

        $connection = PostgisDatabase::connect(static::READ_ONLY);
        // Close the test session instead of resetting its mode to READ WRITE.
        $this->beforeApplicationDestroyed(fn () => DB::purge($connection->getName()));
    }
}
