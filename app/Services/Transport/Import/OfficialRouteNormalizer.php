<?php

namespace App\Services\Transport\Import;

class OfficialRouteNormalizer
{
    public function catalogMetadata(): array
    {
        $catalog = config('transport_routes');

        return [
            'sha256' => hash('sha256', json_encode($catalog, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)),
            'version' => $catalog['version'],
            'source' => $catalog['source'],
            'source_url' => $catalog['source_url'],
            'captured_at' => $catalog['captured_at'],
            'observed_at' => $catalog['observed_at'],
        ];
    }

    public function normalize(string $list, string $transport): array
    {
        $catalog = config('transport_routes');
        $transport = mb_strtolower($transport);
        $modes = array_keys(array_filter([
            'bus' => str_contains($transport, 'автобус') || str_contains($transport, 'автомобиль') || str_contains($transport, 'электробус'),
            'trolleybus' => str_contains($transport, 'трол'),
            'tram' => str_contains($transport, 'трам'),
        ]));
        $routes = [];
        $issues = [];
        $list = trim($list);
        if ($list === '' || $list === '-') {
            return ['routes' => [], 'issues' => ['missing_routes']];
        }

        foreach (preg_split('/[,;]/u', $list) as $rawToken) {
            $original = trim($rawToken);
            $token = preg_replace('/\s+/u', '', mb_strtolower($original));
            $token = preg_replace('/^№+/u', '', $token);
            if (! preg_match('/^\d+[а-яa-z]?$/u', $token) && ! preg_match('/^\d+тр$/u', $token)) {
                $issues[] = 'unparsed_route:'.$original;

                continue;
            }
            $ref = $token;
            $suffixMode = null;
            if (preg_match('/^(\d+)(тр|т)$/u', $token, $suffix)) {
                $ref = $suffix[1];
                $suffixMode = $suffix[2] === 'тр' ? 'tram' : 'trolleybus';
            }
            $candidates = [];
            foreach ($catalog['routes'] as $candidateMode => $refs) {
                if (in_array($ref, $refs, true)) {
                    $candidates[] = $candidateMode;
                }
            }
            $electric = in_array($ref, $catalog['electric_bus_refs'], true);
            if ($electric) {
                $candidates[] = 'bus';
            }
            $mode = 'unknown';
            $method = 'unresolved';
            if ($suffixMode !== null) {
                if (in_array($suffixMode, $candidates, true)) {
                    $mode = $suffixMode;
                    $method = 'catalog_suffix';
                } elseif (in_array($suffixMode, $modes, true)) {
                    $mode = $suffixMode;
                    $method = 'source_suffix';
                    $issues[] = 'route_not_in_catalog:'.$original;
                } else {
                    $ref = $token;
                }
            } elseif (count($candidates) === 1) {
                $mode = $candidates[0];
                $method = 'catalog_unique';
            } elseif (count($modes) === 1 && (! $candidates || in_array($modes[0], $candidates, true))) {
                $mode = $modes[0];
                $method = $candidates ? 'catalog_with_source_type' : 'source_type';
                if (! $candidates) {
                    $issues[] = 'route_not_in_catalog:'.$original;
                }
            }
            if ($mode === 'unknown') {
                $issues[] = 'unknown_route_mode:'.$original;
            } elseif ($modes && ! in_array($mode, $modes, true)) {
                $issues[] = 'source_type_conflict:'.$original;
            }
            $key = $mode.':'.$ref;
            $routes[$key] ??= ['source_id' => $key, 'mode' => $mode, 'ref' => $ref, 'raw_tokens' => [], 'resolutions' => []];
            $routes[$key]['raw_tokens'][] = $original;
            $routes[$key]['resolutions'][] = [
                'token' => $original, 'source_transport' => $transport, 'method' => $method,
                'vehicle_type' => $electric && $mode === 'bus' ? 'electric_bus' : null,
            ];
        }

        return ['routes' => array_values($routes), 'issues' => array_values(array_unique($issues))];
    }
}
