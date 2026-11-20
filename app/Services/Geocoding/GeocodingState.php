<?php

namespace App\Services\Geocoding;

use Illuminate\Database\Connectors\PostgresConnector;
use Illuminate\Support\Facades\Crypt;
use PDO;

/** A private, nonpersistent session: no Laravel reconnect, query events, SQL logs or transaction across HTTP. */
class GeocodingState
{
    private ?PDO $pdo = null;

    private array $held = [];

    private const NS = 170331;

    public function hmac(string $value): string
    {
        $key = config('app.key');
        if (! is_string($key) || $key === '') {
            throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
        }

        return hash_hmac('sha256', 'geocoding-v1:'.$value, $key);
    }

    public function cacheKey(string $method, array $input, array $scope): string
    {
        $inputKey = $method === 'reverse'
            ? bin2hex(pack('E2', $input['lon'] == 0 ? 0.0 : $input['lon'], $input['lat'] == 0 ? 0.0 : $input['lat']))
            : app(AddressNumber::class)->key($input['q']);

        return $this->hmac(json_encode([1, $method === 'reverse' ? 2 : 1, 'geoapify', $method, $input['mode'] ?? null, $scope, 'ru', 5, 'rect', $inputKey], JSON_THROW_ON_ERROR));
    }

    public function rate(string $ip, bool $selection): void
    {
        $this->atomic(function () use ($ip, $selection) {
            $now = $this->time();
            $key = 'ip:'.($selection ? 'selection:' : 'lookup:').$this->hmac($ip).':'.intdiv((int) $now, 60);
            $this->increment($key, $selection ? 60 : 30, (int) $now + 86400, 'RATE_LIMITED', 429, 60 - ((int) $now % 60));
        });
    }

    public function cached(string $key): ?array
    {
        return $this->atomic(function () use ($key) {
            $now = (int) $this->time();
            $this->query('DELETE FROM geocoding_cache WHERE expires_at <= ?', [$now]);
            $r = $this->query('SELECT value FROM geocoding_cache WHERE key = ?', [$key])->fetchColumn();
            if ($r === false) {
                return null;
            }
            try {
                return json_decode(Crypt::decryptString($r), true, 24, JSON_THROW_ON_ERROR);
            } catch (\Throwable) {
                $this->query('DELETE FROM geocoding_cache WHERE key = ?', [$key]);

                return null;
            }
        });
    }

    public function put(string $key, array $value, int $ttl): void
    {
        $encrypted = Crypt::encryptString(json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
        $bytes = strlen($encrypted);
        if ($bytes > 32768) {
            return;
        }
        $this->atomic(function () use ($key, $encrypted, $bytes, $ttl) {
            $now = (int) $this->time();
            $this->query('DELETE FROM geocoding_cache WHERE expires_at <= ? OR key = ?', [$now, $key]);
            $this->query('INSERT INTO geocoding_cache (key,value,bytes,created_at,expires_at) VALUES (?,?,?,?,?)', [$key, $encrypted, $bytes, $now, $now + $ttl]);
            // One window scan gives deterministic oldest-first eviction under the same lock/transaction.
            $this->query('DELETE FROM geocoding_cache WHERE key IN (SELECT key FROM (SELECT key,
                row_number() OVER (ORDER BY created_at DESC,key DESC) AS n,
                sum(bytes) OVER (ORDER BY created_at DESC,key DESC) AS b FROM geocoding_cache) s WHERE n > 5000 OR b > 16777216)');
        });
    }

    /** Acquire before quota accounting. Return only while both advisory locks remain held. */
    public function start(string $ip): void
    {
        try {
            $this->connect();
            if ($this->held !== []) {
                throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
            }
            $ipLock = 100 + (int) hexdec(substr($this->hmac($ip), 0, 7));
            if (! $this->lock($ipLock)) {
                throw new GeocodingFailure('GEOCODING_BUSY', 429, 2);
            }
            $this->held[] = $ipLock;
            for ($slot = 10; $slot < 14; $slot++) {
                if ($this->lock($slot)) {
                    $this->held[] = $slot;
                    break;
                }
            }
            if (count($this->held) !== 2) {
                throw new GeocodingFailure('GEOCODING_BUSY', 429, 2);
            }
            $this->atomic(function () {
                $now = $this->time();
                $fingerprint = $this->hmac('key:'.config('geocoding.api_key'));
                if ($this->value('disabled:'.$fingerprint) !== null) {
                    throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
                }
                $quotaCooldown = $this->value('quota_cooldown');
                if ($quotaCooldown !== null && $quotaCooldown > $now) {
                    throw new GeocodingFailure('GEOCODING_QUOTA_EXHAUSTED', 503, (int) ceil($quotaCooldown - $now));
                }
                $cooldown = $this->value('cooldown');
                if ($cooldown !== null && $cooldown > $now) {
                    throw new GeocodingFailure('PROVIDER_RATE_LIMITED', 429, (int) ceil($cooldown - $now));
                }
                $last = $this->value('last_start');
                if ($last !== null && $now - $last < .5) {
                    throw new GeocodingFailure('RATE_LIMITED', 429, 1);
                }
                $day = intdiv((int) $now, 86400);
                $this->increment('day:'.$day, min(2000, max(0, (int) config('geocoding.daily_limit', 2000))), ($day + 2) * 86400,
                    'GEOCODING_QUOTA_EXHAUSTED', 503, ($day + 1) * 86400 - (int) $now);
                $this->set('last_start', $now, (int) $now + 86400);
            });
            $this->alive();
        } catch (\Throwable $e) {
            $this->finish();
            throw $e instanceof GeocodingFailure ? $e : new GeocodingFailure('GEOCODING_UNAVAILABLE');
        }
    }

    public function alive(): void
    {
        try {
            if (count($this->held) !== 2 || (int) $this->query('SELECT count(*) FROM pg_locks WHERE locktype = ? AND pid = pg_backend_pid() AND classid = ?::oid AND objid IN (?::oid,?::oid) AND objsubid = 2 AND granted',
                ['advisory', self::NS, ...$this->held])->fetchColumn() !== 2) {
                throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
            }
        } catch (\Throwable) {
            throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
        }
    }

    public function upstreamStatus(int $status, ?int $retry): void
    {
        if (! in_array($status, [401, 403, 429], true)) {
            return;
        }
        $this->atomic(function () use ($status, $retry) {
            $now = (int) $this->time();
            if ($status === 429) {
                $until = max($now + max(60, $retry ?? 60), (int) ($this->value('cooldown') ?? 0));
                $this->set('cooldown', $until, $until);
            } else {
                // Persistent until key/configuration is corrected; no speculative reset for generic 403.
                $this->set('disabled:'.$this->hmac('key:'.config('geocoding.api_key')), 1, 253402300799);
            }
        });
    }

    public function upstreamQuota(?int $resetAt = null): int
    {
        return $this->atomic(function () use ($resetAt) {
            $now = (int) $this->time();
            // With no known reset, this is only a cooldown, not a promised recovery time.
            $until = max($resetAt ?? ($now + 3600), $now + 60, (int) ($this->value('quota_cooldown') ?? 0));
            $this->set('quota_cooldown', $until, $until);

            return $until - $now;
        });
    }

    public function finish(): void
    {
        // Closing the dedicated PDO session releases locks, including after failed liveness checks.
        $this->held = [];
        $this->pdo = null;
    }

    public function __destruct()
    {
        $this->finish();
    }

    private function connect(): void
    {
        if ($this->pdo !== null) {
            return;
        }
        $config = config('database.connections.'.config('database.default'));
        if (($config['driver'] ?? null) !== 'pgsql' || ! empty($config['url']) || isset($config['read']) || isset($config['write'])) {
            throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
        }
        $config['options'] = [PDO::ATTR_PERSISTENT => false, PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
        $this->pdo = (new PostgresConnector)->connect($config);
        $this->pdo->exec("SET statement_timeout = '500ms'");
        $this->pdo->exec("SET lock_timeout = '500ms'");
    }

    private function query(string $sql, array $bindings = []): \PDOStatement
    {
        $this->connect();
        $q = $this->pdo->prepare($sql);
        $q->execute($bindings);

        return $q;
    }

    protected function time(): float
    {
        return (float) $this->query('SELECT extract(epoch FROM clock_timestamp())')->fetchColumn();
    }

    private function lock(int $key): bool
    {
        return (bool) $this->query('SELECT pg_try_advisory_lock(?,?)', [self::NS, $key])->fetchColumn();
    }

    private function atomic(\Closure $work): mixed
    {
        $locked = false;
        try {
            $this->connect();
            if (! $this->lock(1)) {
                throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
            }
            $locked = true;
            $this->pdo->beginTransaction();
            $this->query('DELETE FROM geocoding_guards WHERE expires_at <= extract(epoch FROM clock_timestamp())');
            $result = $work();
            $this->pdo->commit();

            return $result;
        } catch (\Throwable $e) {
            if ($this->pdo?->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $e instanceof GeocodingFailure ? $e : new GeocodingFailure('GEOCODING_UNAVAILABLE');
        } finally {
            if ($locked) {
                // Unlock failure also fails closed; never reconnect a session holding slots.
                try {
                    if (! $this->query('SELECT pg_advisory_unlock(?,?)', [self::NS, 1])->fetchColumn()) {
                        throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
                    }
                } catch (\Throwable) {
                    $this->finish();
                    throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
                }
            }
        }
    }

    private function value(string $key): ?float
    {
        $v = $this->query('SELECT value FROM geocoding_guards WHERE key = ?', [$key])->fetchColumn();

        return $v === false ? null : (float) $v;
    }

    private function set(string $key, float $value, int $expires): void
    {
        $this->query('INSERT INTO geocoding_guards (key,value,expires_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at', [$key, $value, $expires]);
    }

    private function increment(string $key, int $max, int $expires, string $code, int $status, int $retry): void
    {
        $n = $this->value($key) ?? 0;
        if ($n >= $max) {
            throw new GeocodingFailure($code, $status, $retry);
        }
        $this->set($key, $n + 1, $expires);
    }
}
