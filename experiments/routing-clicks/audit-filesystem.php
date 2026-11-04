<?php

declare(strict_types=1);

namespace PlaceLens\RoutingClicks;

/** Load a renamed historical guard without writing into its source directory. */
function withOriginalGuard(string $sourceFile, callable $audit): mixed
{
    $sourceFile = realpath($sourceFile);
    if ($sourceFile === false || ! is_file($sourceFile) || ! is_readable($sourceFile)) {
        throw new \RuntimeException('Historical guard source is unavailable.');
    }
    $source = file_get_contents($sourceFile);
    if ($source === false) {
        throw new \RuntimeException('Cannot read historical guard source.');
    }

    $code = '';
    $className = false;
    $renamed = 0;
    foreach (token_get_all($source) as $token) {
        if (is_array($token)) {
            [$id, $text] = $token;
            if ($className && ! in_array($id, [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
                if ($id === T_STRING && $text === 'RoutingGeometryGuard') {
                    $text = 'OriginalRoutingGeometryGuard';
                    $renamed++;
                }
                $className = false;
            }
            if ($id === T_CLASS) {
                $className = true;
            } elseif ($id === T_DIR) {
                $text = var_export(dirname($sourceFile), true);
            } elseif ($id === T_FILE) {
                $text = var_export($sourceFile, true);
            }
        } else {
            $text = $token;
            $className = false;
        }
        $code .= $text;
    }
    if ($renamed !== 1) {
        throw new \RuntimeException('Expected one historical RoutingGeometryGuard declaration.');
    }

    $directory = sys_get_temp_dir().'/placelens-admissions-'.bin2hex(random_bytes(16));
    if (! @mkdir($directory, 0700)) {
        throw new \RuntimeException('Cannot create audit temporary directory.');
    }
    $path = $directory.'/OriginalRoutingGeometryGuard.php';
    $created = false;
    $cleaned = false;
    $cleanup = static function () use ($directory, $path, &$created, &$cleaned): void {
        if ($cleaned) {
            return;
        }
        $cleaned = true;
        if ($created && ! @unlink($path)) {
            fwrite(STDERR, "Could not remove audit temporary PHP file.\n");
        }
        if (! @rmdir($directory)) {
            fwrite(STDERR, "Could not remove audit temporary directory; unexpected contents are preserved.\n");
        }
    };
    // finally handles exceptions; shutdown also covers exit/fatal termination by PHP.
    register_shutdown_function($cleanup);
    try {
        $handle = @fopen($path, 'xb');
        if ($handle === false) {
            throw new \RuntimeException('Cannot create audit temporary PHP file.');
        }
        $created = true;
        try {
            if (fwrite($handle, $code) !== strlen($code)) {
                throw new \RuntimeException('Incomplete audit temporary PHP write.');
            }
        } finally {
            fclose($handle);
        }

        return $audit($path);
    } finally {
        $cleanup();
    }
}

/** Existing outputs, including symlinks, must never be overwritten. */
function writeAuditResults(string $path, array $results): void
{
    // PHP's x mode can follow a dangling symlink and create its target.
    if (file_exists($path) || is_link($path)) {
        throw new \RuntimeException('Cannot create a new audit output file.');
    }
    $json = json_encode($results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)."\n";
    $handle = @fopen($path, 'xb');
    if ($handle === false) {
        throw new \RuntimeException('Cannot create a new audit output file.');
    }
    try {
        if (fwrite($handle, $json) !== strlen($json)) {
            throw new \RuntimeException('Incomplete audit output write; partial output is preserved.');
        }
    } finally {
        fclose($handle);
    }
}
