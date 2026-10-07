<?php

namespace App\Services\Transport\Import;

class OfficialRouteNormalizer
{
    public function normalize(string $list, string $transport): array
    {
        $transport = mb_strtolower($transport);
        $modes = array_keys(array_filter([
            'bus' => str_contains($transport, 'автобус') || str_contains($transport, 'автомобиль'),
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
            $token = preg_replace('/\s+/u', '', mb_strtolower(trim($rawToken)));
            $token = preg_replace('/^№+/u', '', $token);
            if (! preg_match('/^(\d+[а-яa-z]?)(тр|т)?$/u', $token, $match)) {
                $issues[] = 'unparsed_route:'.trim($rawToken);

                continue;
            }
            // Match transport suffixes first: otherwise "7т" would be parsed as a lettered bus number.
            if (preg_match('/^(\d+)(тр|т)$/u', $token, $suffix)) {
                $ref = $suffix[1];
                $mode = $suffix[2] === 'тр' ? 'tram' : 'trolleybus';
                if (! in_array($mode, $modes, true)) {
                    $issues[] = 'transport_conflict:'.trim($rawToken);
                    $mode = 'unknown';
                    $ref = $token;
                }
            } else {
                $ref = $match[1];
                $mode = count($modes) === 1 ? $modes[0] : 'unknown';
            }
            if ($mode === 'unknown') {
                $issues[] = 'unknown_route_mode:'.trim($rawToken);
            }
            $key = $mode.':'.$ref;
            $routes[$key] ??= ['source_id' => $key, 'mode' => $mode, 'ref' => $ref, 'raw_tokens' => []];
            $routes[$key]['raw_tokens'][] = trim($rawToken);
        }

        return ['routes' => array_values($routes), 'issues' => array_values(array_unique($issues))];
    }
}
