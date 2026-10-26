<?php

namespace App\Services\Osm\Import;

use RuntimeException;

/** A source-data problem that can be reported without aborting the snapshot. */
class RejectedAddress extends RuntimeException {}
