<?php

namespace Tests\Unit;

use App\Services\Routing\TripDiagnostics;
use LogicException;
use PHPUnit\Framework\TestCase;

class ReasonCatalogTest extends TestCase
{
    public function test_catalogue_covers_literal_emissions_across_providers_guards_source_chain_and_sql(): void
    {
        // Internal statuses, metadata, and caught exception markers are classified explicitly.
        $internal = ['AMBIGUOUS', 'AVAILABLE', 'CHOOSE', 'CONNECTOR_', 'DERIVED', 'DIFFERENT_STREET_POINTS', 'EXPECTED_SINGLE_GEOJSON_FEATURE', 'EXPLICIT_STREET_POINTS', 'INCOMPLETE_OR_AMBIGUOUS_OSMID', 'INPUT_STREET_POINTS', 'INSUFFICIENT_DATA', 'INVALID_COORDINATES', 'INVALID_FULL_LINE', 'INVALID_MEASURES', 'INVALID_OSMID_RANGE', 'INVALID_POSITIVE_ROUTE_MEASURES', 'MATCHED', 'MISSING_OSMID_RANGES', 'NEEDS_REFINEMENT', 'NONE', 'NOT_INCLUDED', 'NOT_PREPARED', 'NO_PATH', 'ORIGINAL_IN_', 'ORS', 'OSRM', 'OUTSIDE_PILOT', 'ROUTE_', 'SELECTED', 'SQL', 'UNAVAILABLE', 'UNKNOWN', 'UNMATCHED', 'UTC'];
        $root = dirname(__DIR__, 2);
        $catalog = json_decode(file_get_contents($root.'/resources/contracts/reason-codes.json'), true, flags: JSON_THROW_ON_ERROR);
        $known = array_merge($catalog['routing'], $catalog['trip_status'], $catalog['road_choice_status'], $internal);
        foreach (['LocalCarRouterProvider.php', 'LocalWalkingRouterProvider.php', 'RoutingGeometryGuard.php', 'WalkingGeometryGuard.php',
            'WalkingSourceChain.php', 'connector-issues.sql', 'snap-candidates.sql', 'geometry.sql'] as $file) {
            preg_match_all("/'([A-Z][A-Z0-9_]{2,})'/", file_get_contents($root.'/app/Services/Routing/'.$file), $matches);
            $this->assertSame([], array_values(array_diff(array_unique($matches[1]), $known)), $file);
        }
        foreach (['AddressResolverService.php' => 'resolver', 'AddressProfileService.php' => 'environment'] as $file => $namespace) {
            preg_match_all("/'([A-Z][A-Z0-9_]{2,})'/", file_get_contents($root.'/app/Services/Addresses/'.$file), $matches);
            $this->assertSame([], array_values(array_diff(array_unique($matches[1]), $catalog[$namespace], ['READY', 'ERROR', 'UTC'])), $file);
        }
        foreach (['CONNECTOR', 'ROUTE', 'ORIGINAL_IN'] as $prefix) {
            foreach (['BUILDING', 'WATER'] as $kind) {
                $this->assertContains($prefix.'_'.$kind, $catalog['routing']);
            }
        }
    }

    public function test_runtime_catalogue_gate_rejects_new_sql_dynamic_and_provider_codes(): void
    {
        foreach ([['status' => 'UNKNOWN', 'checks' => ['NEW_SQL_REASON']],
            ['status' => 'UNKNOWN', 'checks' => [], 'road_choices' => ['start' => ['status' => 'CHOOSE', 'checks' => ['NEW_DYNAMIC_REASON']]]]] as $row) {
            try {
                TripDiagnostics::validateRow($row);
                $this->fail('Unchecked public code escaped');
            } catch (LogicException $error) {
                $this->assertSame('Unregistered public reason code.', $error->getMessage());
            }
        }
    }

    public function test_unknown_location_is_not_choice_or_endpoint_inference(): void
    {
        $unknown = TripDiagnostics::envelope([TripDiagnostics::issue('ROUTER_NO_SEGMENT')], 2);
        $this->assertSame('unknown', $unknown['issues'][0]['location']);
        $this->assertNull($unknown['issues'][0]['target_index']);
        $choose = TripDiagnostics::envelope([TripDiagnostics::issue('SNAP_CHOICE_REQUIRED', 'target', 'snap')], 2);
        $this->assertSame(2, $choose['issues'][0]['target_index']);
    }
}
