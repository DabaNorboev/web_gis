<?php

namespace App\Services\Geocoding;

class AddressNumber
{
    public function key(string $value): string
    {
        if (! class_exists(\Normalizer::class)) {
            throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
        }

        return str_replace('ё', 'е', mb_strtolower(trim(preg_replace('/\s+/u', ' ', \Normalizer::normalize($value, \Normalizer::FORM_C)))));
    }

    public function parse(?string $raw): array
    {
        $result = ['raw' => $raw, 'key' => $raw === null ? null : $this->key($raw), 'base' => null, 'fraction' => null,
            'letter' => null, 'corpus' => null, 'structure' => null, 'parse_status' => 'UNKNOWN'];
        if ($raw === null || ! preg_match('/^(?:д\.?\s*|дом\s+)?(?<base>\d+)(?:\/(?<fraction>\d+))?\s*(?:(?:лит(?:ера)?\.?\s*)?(?<letter>[а-яa-z]))?(?:\s*(?:к|корп(?:ус)?\.?)\s*(?<corpus>\d+[а-яa-z]?))?(?:\s*(?:стр(?:оение)?\.?)\s*(?<structure>\d+[а-яa-z]?))?$/uD', $result['key'], $m)) {
            return $result;
        }
        foreach (['base', 'fraction', 'letter', 'corpus', 'structure'] as $field) {
            $result[$field] = ($m[$field] ?? '') === '' ? null : $m[$field];
        }
        $result['key'] = implode('|', array_map(fn ($k) => $result[$k] ?? '', ['base', 'fraction', 'letter', 'corpus', 'structure']));
        $result['parse_status'] = 'COMPLETE';

        return $result;
    }

    public function requested(string $query): ?array
    {
        $query = $this->key($query);
        // Try complete suffixes, preserving ambiguous alternatives rather than selecting the last one.
        preg_match_all('/\s+((?:д\.?\s*|дом\s+)?\d+)/u', $query, $matches, PREG_OFFSET_CAPTURE);
        $streetPattern = '/^\d+\s+(?:лет|мая|марта|ноября|декабря|января|февраля|апреля|июня|июля|августа|сентября|октября)\b/u';
        $numberedStreet = preg_match($streetPattern, $query) === 1;
        if (preg_match('/^(?:д\.?\s*|дом\s+)?\d+/u', $query) && ! $numberedStreet) {
            return $this->parse($query);
        }
        foreach ($matches[1] as [$start, $offset]) {
            $prefix = substr($query, 0, $offset);
            if (! preg_match('/\p{L}/u', $prefix)) {
                continue;
            }
            $tail = substr($query, $offset);
            $number = $this->parse($tail);
            if (str_contains($tail, ',')) {
                return $number;
            }
            if ($number['parse_status'] === 'COMPLETE') {
                return $number;
            }
            // A numbered street name alone does not request a house number.
            if (! preg_match($streetPattern, $tail)) {
                return $number;
            }
            $numberedStreet = true;
        }

        return $numberedStreet || ! preg_match('/\d/u', $query) ? null : $this->parse($query);
    }
}
