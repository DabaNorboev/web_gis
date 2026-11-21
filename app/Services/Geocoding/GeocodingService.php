<?php

namespace App\Services\Geocoding;

use Carbon\CarbonImmutable;

class GeocodingService
{
    public function __construct(private GeocodingScope $scope, private GeoapifyNormalizer $normalizer,
        private GeocodingTokens $tokens, private GeocodingState $state, private GeoapifyTransport $transport) {}

    public function execute(string $method, array $input, string $ip): array
    {
        if ($method === 'confirm' || $method === 'reconfirm') {
            $data = $method === 'confirm' ? $this->tokens->confirm($input['candidate_token']) : $this->tokens->reconfirm($input['selection_token']);

            return ['data' => $data, 'meta' => $this->meta($input['request_id'], 'NONE', $data['place']['address']['source']['received_at'])];
        }
        $bounds = $this->scope->bounds(); // Validate boundary even on cache hit and before outbound admission.
        $point = $method === 'reverse' ? ['lon' => $input['lon'], 'lat' => $input['lat']] : null;
        if ($point !== null && ! $this->scope->covers($point)) {
            return ['data' => ['status' => 'EMPTY', 'reason' => 'OUTSIDE_SCOPE', 'point' => $point, 'candidates' => []],
                'meta' => $this->meta($input['request_id'], 'NONE', null)];
        }
        $key = $this->state->cacheKey($method, $input, $this->scope->identity());
        $cached = $this->state->cached($key);
        $cache = $cached === null ? 'MISS' : 'HIT';
        if ($cached === null) {
            if (! config('geocoding.enabled') || ! is_string(config('geocoding.api_key')) || config('geocoding.api_key') === '' || ! $this->transport->available()) {
                throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
            }
            $parameters = ['lang' => 'ru', 'limit' => 5, 'format' => 'json'];
            if ($point !== null) {
                $parameters += $point;
            } else {
                $parameters += ['text' => $input['q'], 'filter' => 'rect:'.implode(',', $bounds)];
            }
            $this->state->start($ip);
            try {
                $rows = $this->transport->request($method === 'search' ? $input['mode'] : 'reverse', $parameters, $this->state);
            } finally {
                $this->state->finish();
            }
            $received = CarbonImmutable::now('UTC')->toISOString();
            $normalized = $this->normalizer->normalize($rows, $input['q'] ?? null, $received);
            if ($point !== null && $normalized['candidates'] !== []) {
                $normalized['candidates'] = $this->scope->nearby($point, $normalized['candidates']);
                if ($normalized['candidates'] === []) {
                    $normalized['status'] = 'EMPTY';
                    $normalized['reason'] = 'NO_NEARBY_RESULTS';
                } elseif (array_any($normalized['candidates'], fn ($candidate) => $candidate['can_confirm'])) {
                    $normalized['status'] = 'OK';
                    $normalized['reason'] = null;
                } else {
                    $normalized['status'] = 'NO_SELECTABLE_RESULTS';
                    $normalized['reason'] = 'POSITION_REQUIRES_POINT';
                }
            }
            foreach ($normalized['candidates'] as &$candidate) {
                if ($candidate['can_confirm']) {
                    $candidate = $this->tokens->prepareCandidate($candidate);
                }
            }
            unset($candidate);
            $cached = ['data' => $normalized, 'received_at' => $normalized['candidates'] === [] ? null : $received];
            $this->state->put($key, $cached, $cached['data']['status'] === 'EMPTY' ? 60 : ($point === null ? 300 : 3600));
        }
        $data = $cached['data'];
        // Never cache bearer tokens. Reissue from normalized snapshots without refreshing source dates.
        foreach ($data['candidates'] as &$candidate) {
            $candidate += $candidate['can_confirm'] ? $this->tokens->candidate($candidate) : ['candidate_token' => null, 'expires_at' => null];
        }
        unset($candidate);
        if ($point !== null) {
            $data['point'] = $point;
        }

        return ['data' => $data, 'meta' => $this->meta($input['request_id'], $cache, $cached['received_at'])];
    }

    private function meta(string $id, string $cache, ?string $received): array
    {
        return ['contract_version' => 1, 'request_id' => $id, 'provider' => 'geoapify'] + $this->scope->identity()
            + ['received_at' => $received, 'cache' => $cache, 'attribution' => GeoapifyNormalizer::ATTRIBUTION];
    }
}
