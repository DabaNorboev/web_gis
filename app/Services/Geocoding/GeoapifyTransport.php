<?php

namespace App\Services\Geocoding;

class GeoapifyTransport
{
    public function available(): bool
    {
        if (! function_exists('curl_version')) {
            return false;
        }
        $version = curl_version();

        // ASYNCHDNS also covers a threaded getaddrinfo resolver. In the target 7.88.1
        // runtime a stalled DNS call took 10s despite both 2s/8s deadlines. Require
        // c-ares so an uninterruptible resolver cannot outlive the transfer budget.
        return ($version['features'] & CURL_VERSION_ASYNCHDNS) !== 0 && ! empty($version['ares']);
    }

    public function request(string $method, array $parameters, GeocodingState $state): array
    {
        if (! $this->available()) {
            throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
        }
        $path = match ($method) {
            'search' => '/v1/geocode/search', 'autocomplete' => '/v1/geocode/autocomplete', 'reverse' => '/v1/geocode/reverse',
            default => throw new GeocodingFailure('GEOCODING_UNAVAILABLE'),
        };
        // Host/path are constants; callers cannot inject an endpoint, URL, headers or forwarded client identity.
        $url = 'https://api.geoapify.com'.$path.'?'.http_build_query($parameters + ['apiKey' => config('geocoding.api_key')], '', '&', PHP_QUERY_RFC3986);

        return $this->transfer($url, $state);
    }

    /** The protected URL and optional CA file support isolated loopback TLS fixtures. */
    protected function transfer(string $url, GeocodingState $state, ?string $caFile = null): array
    {
        $curl = curl_init();
        $body = '';
        $oversize = false;
        $guardFailure = false;
        $retry = null;
        $previousAbort = ignore_user_abort(true);
        $lastCheck = 0.0;
        try {
            curl_setopt_array($curl, [
                CURLOPT_URL => $url, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
                CURLOPT_FOLLOWLOCATION => false, CURLOPT_MAXREDIRS => 0, CURLOPT_CONNECTTIMEOUT_MS => 2000,
                CURLOPT_TIMEOUT_MS => 8000, CURLOPT_NOSIGNAL => true, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_PROXY => '', CURLOPT_ENCODING => '', CURLOPT_HTTPHEADER => ['Accept: application/json'],
                CURLOPT_USERAGENT => 'PlaceLens-Geocoding/1', CURLOPT_VERBOSE => false,
                CURLOPT_WRITEFUNCTION => function ($handle, string $chunk) use (&$body, &$oversize): int {
                    if (strlen($body) + strlen($chunk) > 1048576) {
                        $oversize = true;

                        return 0;
                    }
                    $body .= $chunk;

                    return strlen($chunk);
                },
                CURLOPT_HEADERFUNCTION => function ($handle, string $line) use (&$retry): int {
                    if (preg_match('/^Retry-After:\s*(\d{1,9})\s*$/iD', trim($line), $m)) {
                        $retry = (int) $m[1];
                    } elseif (stripos($line, 'Retry-After:') === 0) {
                        $time = strtotime(trim(substr($line, 12)));
                        if ($time !== false && $time > time()) {
                            $retry = min(31536000, $time - time());
                        }
                    }

                    return strlen($line);
                },
                CURLOPT_NOPROGRESS => false,
                CURLOPT_XFERINFOFUNCTION => function () use ($state, &$guardFailure, &$lastCheck): int {
                    if (microtime(true) - $lastCheck < .1) {
                        return 0;
                    }
                    try {
                        $state->alive();
                        $lastCheck = microtime(true);

                        return 0;
                    } catch (\Throwable) {
                        $guardFailure = true;

                        return 1;
                    }
                },
            ]);
            if ($caFile !== null) {
                curl_setopt($curl, CURLOPT_CAINFO, $caFile);
            }
            $state->alive();
            $ok = curl_exec($curl);
            $errno = curl_errno($curl); // Never retain/log curl_error or effective URL.
            $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            $state->alive();
            if ($guardFailure) {
                throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
            }
            if ($oversize) {
                throw new GeocodingFailure('PROVIDER_RESPONSE_INVALID', 502);
            }
            if ($ok === false) {
                throw new GeocodingFailure($errno === CURLE_OPERATION_TIMEDOUT ? 'PROVIDER_TIMEOUT' : 'GEOCODING_UNAVAILABLE', $errno === CURLE_OPERATION_TIMEDOUT ? 504 : 503);
            }
            // Exhaustion requires an explicit machine code. Generic 403/message text is never quota.
            $errorBody = json_decode($body, true);
            $machineCode = is_array($errorBody) ? ($errorBody['code'] ?? (is_array($errorBody['error'] ?? null) ? ($errorBody['error']['code'] ?? null) : null)) : null;
            if ($status >= 400 && in_array($machineCode, ['QUOTA_EXCEEDED', 'DAILY_QUOTA_EXCEEDED'], true)) {
                $reset = $errorBody['reset_at'] ?? null;
                $reset = is_int($reset) && $reset > time() && $reset <= 253402300799 ? $reset : null;
                throw new GeocodingFailure('GEOCODING_QUOTA_EXHAUSTED', 503, $state->upstreamQuota($reset));
            }
            $state->upstreamStatus($status, $retry);
            if ($status === 429) {
                throw new GeocodingFailure('PROVIDER_RATE_LIMITED', 429, max(60, $retry ?? 60));
            }
            if ($status === 401 || $status === 403) {
                throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
            }
            if ($status !== 200) {
                throw new GeocodingFailure('PROVIDER_RESPONSE_INVALID', 502);
            }
            try {
                $json = json_decode($body, true, 32, JSON_THROW_ON_ERROR);
                if (! is_array($json) || ! isset($json['results']) || ! is_array($json['results']) || ! array_is_list($json['results']) || count($json['results']) > 5) {
                    throw new \RuntimeException;
                }

                return $json['results'];
            } catch (\Throwable) {
                throw new GeocodingFailure('PROVIDER_RESPONSE_INVALID', 502);
            }
        } finally {
            // In PHP 8.4 curl_close is a no-op: release the handle itself before releasing advisory slots.
            unset($curl);
            $state->finish();
            ignore_user_abort((bool) $previousAbort);
        }
    }
}
