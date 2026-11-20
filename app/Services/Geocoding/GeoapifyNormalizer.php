<?php

namespace App\Services\Geocoding;

use Illuminate\Support\Str;

class GeoapifyNormalizer
{
    public const ATTRIBUTION = [
        ['text' => 'Powered by Geoapify', 'url' => 'https://www.geoapify.com/'],
        ['text' => '© OpenStreetMap contributors', 'url' => 'https://www.openstreetmap.org/copyright'],
    ];

    public function __construct(private AddressNumber $numbers, private GeocodingScope $scope) {}

    public function normalize(array $rows, ?string $query, string $receivedAt): array
    {
        $result = [];
        $filtered = false;
        $requested = $query === null ? null : $this->numbers->requested($query);
        foreach ($rows as $row) {
            if (! is_array($row)) {
                throw new GeocodingFailure('PROVIDER_RESPONSE_INVALID', 502);
            }
            $country = $this->string($row, 'country_code', 128);
            $point = $this->point($row);
            if (($country !== null && strtolower($country) !== 'ru') || ($point !== null && ! $this->scope->covers($point))) {
                $filtered = true;

                continue;
            }
            $number = $this->numbers->parse($this->string($row, 'housenumber', 128));
            $street = $this->string($row, 'street', 256);
            $type = $this->string($row, 'result_type', 128);
            $level = match ($type) {
                'building' => $street !== null && $street !== '' && $point !== null && $number['parse_status'] === 'COMPLETE' ? 'house' : null,
                'street' => 'street',
                'city', 'town', 'village', 'suburb', 'district', 'county', 'state', 'country', 'postcode' => 'locality',
                default => null,
            };
            $match = $query === null || $requested === null ? 'NOT_REQUESTED'
                : ($requested['parse_status'] !== 'COMPLETE' || $number['parse_status'] !== 'COMPLETE' ? 'UNKNOWN'
                    : ($requested['key'] === $number['key'] ? 'EXACT' : 'MISMATCH'));
            $candidate = ['candidate_id' => (string) Str::uuid(), 'provider_id' => $this->string($row, 'place_id', 1024, true),
                'label' => $this->string($row, 'formatted', 512) ?? '',
                'components' => ['country_code' => $country, 'locality' => $this->string($row, 'city', 128) ?? $this->string($row, 'town', 128) ?? $this->string($row, 'village', 128), 'street' => $street, 'number' => $number],
                'point' => $point, 'point_reason' => $point === null ? 'COORDINATES_MISSING' : null,
                'precision' => ['level' => $level, 'reason' => $level === null ? 'PROVIDER_LEVEL_UNKNOWN' : null, 'accuracy_m' => null, 'accuracy_reason' => 'NOT_VALIDATED'],
                'number_match' => $match, 'within_scope' => $point === null ? null : true,
                'source' => ['provider' => 'geoapify', 'provider_result_type' => $type, 'observed_at' => null, 'source_updated_at' => null,
                    'received_at' => $receivedAt, 'normalization_version' => 1, 'attribution' => self::ATTRIBUTION]];
            if ($candidate['label'] === '') {
                throw new GeocodingFailure('PROVIDER_RESPONSE_INVALID', 502);
            }
            $candidate['restrictions'] = self::restrictions($candidate);
            $candidate['can_confirm'] = $candidate['restrictions'] === [];
            $result[] = $candidate;
        }
        $status = $result === [] ? 'EMPTY' : (in_array(true, array_column($result, 'can_confirm'), true) ? 'OK' : 'NO_SELECTABLE_RESULTS');

        return ['status' => $status, 'reason' => match ($status) {
            'OK' => null, 'NO_SELECTABLE_RESULTS' => 'POSITION_REQUIRES_POINT', default => $filtered ? 'NO_IN_SCOPE_RESULTS' : 'NO_RESULTS',
        }, 'candidates' => $result];
    }

    public static function restrictions(array $c): array
    {
        $r = [];
        if ($c['point'] === null || $c['within_scope'] !== true) {
            $r[] = 'COORDINATES_MISSING';
        }
        if (! is_string($c['provider_id']) || $c['provider_id'] === '') {
            $r[] = 'PROVIDER_ID_MISSING';
        }
        if ($c['precision']['level'] !== 'house') {
            $r[] = 'HOUSE_REQUIRED';
        }
        if ($c['number_match'] === 'MISMATCH') {
            $r[] = 'NUMBER_MISMATCH';
        }
        if ($c['components']['number']['parse_status'] !== 'COMPLETE' || $c['number_match'] === 'UNKNOWN') {
            $r[] = 'NUMBER_UNVERIFIED';
        }

        return $r;
    }

    private function string(array $row, string $key, int $max, bool $bytes = false): ?string
    {
        $v = $row[$key] ?? null;
        if ($v !== null && (! is_string($v) || ($bytes ? strlen($v) : mb_strlen($v)) > $max)) {
            throw new GeocodingFailure('PROVIDER_RESPONSE_INVALID', 502);
        }

        return $v;
    }

    private function point(array $row): ?array
    {
        if (! isset($row['lon'], $row['lat'])) {
            return null;
        }
        foreach (['lon' => 180, 'lat' => 90] as $k => $max) {
            if ((! is_float($row[$k]) && ! is_int($row[$k])) || ! is_finite((float) $row[$k]) || abs($row[$k]) > $max) {
                throw new GeocodingFailure('PROVIDER_RESPONSE_INVALID', 502);
            }
        }

        return ['lon' => $row['lon'], 'lat' => $row['lat']];
    }
}
