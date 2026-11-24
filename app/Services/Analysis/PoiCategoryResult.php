<?php

namespace App\Services\Analysis;

final readonly class PoiCategoryResult
{
    private function __construct(
        public string $status,
        public ?string $code,
        public array $coverage,
        public array $completeness,
        public array $items,
        public ?int $count,
        public ?array $officialStopSummary = null,
    ) {}

    public static function ready(array $coverage, array $completeness, array $items, ?array $officialStopSummary = null): self
    {
        $count = $coverage['status'] === 'COVERED' && $completeness['status'] !== 'PARTIAL'
            ? count($items)
            : null;

        return new self('READY', null, $coverage, $completeness, $items, $count, $officialStopSummary);
    }

    public static function unavailable(string $code, string $reason): self
    {
        return self::withoutData('UNAVAILABLE', $code, $reason);
    }

    public static function failed(string $reason): self
    {
        return self::withoutData('ERROR', 'CATEGORY_CALCULATION_FAILED', $reason);
    }

    private static function withoutData(string $status, string $code, string $reason): self
    {
        return new self($status, $code, ['status' => 'UNKNOWN', 'reason' => $reason, 'available_radius_m' => null],
            ['status' => 'UNKNOWN', 'reason' => $reason], [], null);
    }
}
