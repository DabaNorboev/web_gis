<?php

namespace App\Services\Geocoding;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Str;

class GeocodingTokens
{
    public function __construct(private GeocodingScope $scope, private AddressNumber $numbers) {}

    public function candidate(array $candidate): array
    {
        // Reverse distance describes the lookup origin, not the address snapshot.
        unset($candidate['reference_distance_m']);
        $now = $this->now();
        $payload = ['schema' => 1, 'purpose' => 'geocoding_candidate', 'provider' => 'geoapify',
            'issued_at' => $now, 'expires_at' => $now + 900, 'candidate' => $candidate] + $this->scope->identity();

        return ['candidate_token' => $this->encrypt($payload), 'expires_at' => $this->iso($now + 900)];
    }

    public function confirm(string $token): array
    {
        $p = $this->decode($token, 'candidate');
        $this->fields($p, ['schema', 'purpose', 'provider', 'issued_at', 'expires_at', 'candidate', 'scope_id', 'scope_sha256']);
        $this->times($p, false);
        $this->need(is_string($p['scope_id']) && $p['scope_id'] !== '' && is_string($p['scope_sha256']) && preg_match('/^[a-f0-9]{64}$/D', $p['scope_sha256']) === 1);
        $this->validateCandidate($p['candidate']);
        $this->need(CarbonImmutable::parse($p['candidate']['source']['received_at'])->getTimestamp() <= $p['issued_at']);
        $this->currentScope($p);
        if ($this->now() >= $p['expires_at']) {
            throw new GeocodingFailure('CANDIDATE_EXPIRED', 410);
        }
        $c = $p['candidate'];
        $id = (string) Str::uuid();
        $place = ['kind' => 'address', 'selection_id' => $id, 'label' => $c['label'], 'point' => $c['point'],
            'address' => ['provider_id' => $c['provider_id'], 'components' => $c['components'], 'precision' => $c['precision'],
                'number_match' => $c['number_match'], 'source' => $c['source'], 'scope_id' => $p['scope_id'], 'scope_sha256' => $p['scope_sha256']], 'building' => null];
        $now = $this->now();

        return $this->selectionResponse(['schema' => 1, 'purpose' => 'geocoding_selection', 'provider' => 'geoapify',
            'selection_id' => $id, 'place' => $place, 'snapshot_created_at' => $now, 'snapshot_expires_at' => $now + 7 * 86400,
            'issued_at' => $now, 'expires_at' => $now + 86400]);
    }

    public function selection(string $token, bool $reconfirm = false): array
    {
        $p = $this->decode($token, 'selection');
        $this->fields($p, ['schema', 'purpose', 'provider', 'selection_id', 'place', 'snapshot_created_at', 'snapshot_expires_at', 'issued_at', 'expires_at']);
        $this->times($p, true);
        $place = $p['place'];
        $this->fields($place, ['kind', 'selection_id', 'label', 'point', 'address', 'building']);
        $this->need($place['kind'] === 'address' && $place['building'] === null && $this->uuid($p['selection_id']) && $place['selection_id'] === $p['selection_id']);
        $a = $place['address'];
        $this->fields($a, ['provider_id', 'components', 'precision', 'number_match', 'source', 'scope_id', 'scope_sha256']);
        $this->validateSnapshot($place['label'], $place['point'], $a);
        $this->need(CarbonImmutable::parse($a['source']['received_at'])->getTimestamp() <= $p['snapshot_created_at']);
        if ($reconfirm) {
            $this->currentScope($a);
            if ($this->now() >= $p['snapshot_expires_at']) {
                throw new GeocodingFailure('SNAPSHOT_EXPIRED', 410);
            }
        } elseif ($this->now() >= $p['expires_at']) {
            throw new GeocodingFailure('SELECTION_EXPIRED', 410);
        }

        return $p;
    }

    public function reconfirm(string $token): array
    {
        $p = $this->selection($token, true);
        $p['issued_at'] = $this->now();
        $p['expires_at'] = min($this->now() + 86400, $p['snapshot_expires_at']);

        return $this->selectionResponse($p);
    }

    private function selectionResponse(array $p): array
    {
        return ['selection_id' => $p['selection_id'], 'selection_token' => $this->encrypt($p),
            'expires_at' => $this->iso($p['expires_at']), 'snapshot_expires_at' => $this->iso($p['snapshot_expires_at']), 'place' => $p['place']];
    }

    private function validateCandidate(mixed $c): void
    {
        $this->fields($c, ['candidate_id', 'provider_id', 'label', 'components', 'point', 'point_reason', 'precision', 'number_match', 'within_scope', 'source', 'restrictions', 'can_confirm']);
        $this->need($this->uuid($c['candidate_id']) && $c['can_confirm'] === true && $c['restrictions'] === [] && $c['point_reason'] === null && $c['within_scope'] === true);
        $this->validateSnapshot($c['label'], $c['point'], $c + $this->scope->identity());
        $this->need(GeoapifyNormalizer::restrictions($c) === []);
    }

    private function validateSnapshot(mixed $label, mixed $point, array $a): void
    {
        $this->need(is_string($label) && $label !== '' && mb_strlen($label) <= 512);
        $this->fields($point, ['lon', 'lat']);
        foreach (['lon' => 180, 'lat' => 90] as $key => $limit) {
            $this->need((is_float($point[$key]) || is_int($point[$key])) && is_finite((float) $point[$key]) && abs($point[$key]) <= $limit);
        }
        $this->need(is_string($a['provider_id']) && $a['provider_id'] !== '' && strlen($a['provider_id']) <= 1024);
        $this->need(is_string($a['scope_id']) && $a['scope_id'] !== '' && is_string($a['scope_sha256']) && preg_match('/^[a-f0-9]{64}$/D', $a['scope_sha256']) === 1);
        $this->fields($a['precision'], ['level', 'reason', 'accuracy_m', 'accuracy_reason']);
        $this->need($a['precision'] === ['level' => 'house', 'reason' => null, 'accuracy_m' => null, 'accuracy_reason' => 'NOT_VALIDATED']);
        $this->need(in_array($a['number_match'], ['EXACT', 'NOT_REQUESTED'], true));
        $c = $a['components'];
        $this->fields($c, ['country_code', 'locality', 'street', 'number']);
        foreach (['country_code' => 128, 'locality' => 128, 'street' => 256] as $k => $limit) {
            $this->need($c[$k] === null || (is_string($c[$k]) && mb_strlen($c[$k]) <= $limit));
        }
        $this->need(is_string($c['street']) && $c['street'] !== '' && ($c['country_code'] === null || strtolower($c['country_code']) === 'ru'));
        $n = $c['number'];
        $this->need(is_array($n) && is_string($n['raw'] ?? null) && mb_strlen($n['raw']) <= 128);
        $this->need($n === $this->numbers->parse($n['raw']) && $n['parse_status'] === 'COMPLETE');
        $s = $a['source'];
        $this->fields($s, ['provider', 'provider_result_type', 'observed_at', 'source_updated_at', 'received_at', 'normalization_version', 'attribution']);
        $this->need($s['provider'] === 'geoapify' && $s['provider_result_type'] === 'building' && $s['observed_at'] === null && $s['source_updated_at'] === null && $s['normalization_version'] === 1 && $s['attribution'] === GeoapifyNormalizer::ATTRIBUTION);
        $this->need(is_string($s['received_at']) && preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/D', $s['received_at']) === 1);
        try {
            $received = CarbonImmutable::parse($s['received_at']);
            $this->need($received->getTimestamp() <= $this->now() && $received->format('Y-m-d\\TH:i:s') === substr($s['received_at'], 0, 19));
        } catch (\Throwable) {
            $this->need(false);
        }
    }

    private function times(array $p, bool $selection): void
    {
        foreach ($selection ? ['issued_at', 'expires_at', 'snapshot_created_at', 'snapshot_expires_at'] : ['issued_at', 'expires_at'] as $k) {
            $this->need(is_int($p[$k]) && $p[$k] >= 0 && $p[$k] <= 253402300799);
        }
        $this->need($p['issued_at'] <= $this->now() && $p['issued_at'] < $p['expires_at']);
        if ($selection) {
            $this->need($p['snapshot_created_at'] <= $p['issued_at'] && $p['snapshot_expires_at'] === $p['snapshot_created_at'] + 7 * 86400
                && $p['expires_at'] <= min($p['issued_at'] + 86400, $p['snapshot_expires_at']));
        } else {
            $this->need($p['expires_at'] === $p['issued_at'] + 900);
        }
    }

    private function currentScope(array $p): void
    {
        foreach ($this->scope->identity() as $k => $v) {
            if ($p[$k] !== $v) {
                throw new GeocodingFailure('SCOPE_CHANGED', 409);
            }
        }
        $this->scope->bounds(); // Current selection exchanges require a valid pinned boundary; analysis does not.
    }

    private function decode(string $token, string $purpose): array
    {
        try {
            $this->need(strlen($token) <= 6144);
            $p = json_decode(Crypt::decryptString($token), true, 24, JSON_THROW_ON_ERROR);
            $this->need(is_array($p) && ($p['schema'] ?? null) === 1 && ($p['purpose'] ?? null) === 'geocoding_'.$purpose && ($p['provider'] ?? null) === 'geoapify');

            return $p;
        } catch (\Throwable) {
            throw new GeocodingFailure('INVALID_SELECTION', 422);
        }
    }

    private function encrypt(array $p): string
    {
        $token = Crypt::encryptString(json_encode($p, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        if (strlen($token) > 6144) {
            throw new GeocodingFailure('PROVIDER_RESPONSE_INVALID', 502);
        }

        return $token;
    }

    private function fields(mixed $v, array $keys): void
    {
        $this->need(is_array($v) && count($v) === count($keys) && array_diff($keys, array_keys($v)) === []);
    }

    private function need(bool $condition): void
    {
        if (! $condition) {
            throw new GeocodingFailure('INVALID_SELECTION', 422);
        }
    }

    private function uuid(mixed $v): bool
    {
        return is_string($v) && Str::isUuid($v, 4);
    }

    private function now(): int
    {
        return CarbonImmutable::now('UTC')->getTimestamp();
    }

    private function iso(int $timestamp): string
    {
        return CarbonImmutable::createFromTimestampUTC($timestamp)->toISOString();
    }
}
