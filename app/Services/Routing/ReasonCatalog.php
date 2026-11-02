<?php

namespace App\Services\Routing;

use LogicException;

/** Public machine-code authority, independent of UI explanations. */
final class ReasonCatalog
{
    public static function all(): array
    {
        static $catalog;

        return $catalog ??= json_decode(file_get_contents(dirname(__DIR__, 3).'/resources/contracts/reason-codes.json'), true, flags: JSON_THROW_ON_ERROR);
    }

    public static function require(string $namespace, string $code): void
    {
        if (! in_array($code, self::all()[$namespace] ?? [], true)) {
            // No unchecked code, response body or personal input reaches this message.
            throw new LogicException('Unregistered public reason code.');
        }
    }
}
