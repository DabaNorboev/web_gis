<?php

namespace App\Services\Addresses;

use App\Services\Gis\AnalysisArea;
use App\Services\Osm\Analysis\OsmAreaAnalysisService;
use App\Services\Osm\Analysis\OsmAreaKind;
use App\Services\Osm\Analysis\OsmAreaMapService;
use App\Services\Osm\Analysis\OsmLinearAnalysisService;
use App\Services\Osm\Analysis\OsmLinearMapService;
use App\Services\Osm\Import\OsmLinearDataset;
use App\Services\Transport\TransportAnalysisService;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

class AddressProfileService
{
    public const BLOCKS = ['transport', 'parks', 'vegetation', 'water', 'roads', 'railways'];

    public function __construct(private AnalysisArea $area, private TransportAnalysisService $transport,
        private OsmAreaAnalysisService $areas, private OsmLinearAnalysisService $linear, private OsmAreaMapService $areaMap, private OsmLinearMapService $linearMap, private AddressResolverService $resolver) {}

    public function profile(string $id, int $radiusM = 500, ?array $selectedBlocks = null): array
    {
        $this->resolver->validateId($id);
        $selected = $selectedBlocks !== null;
        $wanted = $selectedBlocks ?? self::BLOCKS;
        abort_unless($wanted && count($wanted) === count(array_unique($wanted)) && ! array_diff($wanted, self::BLOCKS), 422);
        $snapshots = $this->resolver->snapshots();
        $address = $this->resolver->resolve($id, $snapshots);
        $lon = $address['object']['lon'];
        $lat = $address['object']['lat'];
        $blocks = [];
        $calculations = ['transport' => fn () => $this->transport->analyze($lon, $lat, $radiusM, $snapshots)];
        foreach (OsmAreaKind::cases() as $kind) {
            $calculations[$kind->value] = fn () => $this->areas->forKind($kind, $snapshots[$kind->dataset()] ?? null, $lon, $lat, $radiusM);
        }
        foreach (OsmLinearDataset::cases() as $dataset) {
            $calculations[$dataset->value] = fn () => $this->linear->forDataset($dataset, $snapshots[$dataset->value] ?? null, $lon, $lat, $radiusM);
        }
        foreach (array_intersect_key($calculations, array_flip($wanted)) as $key => $calculation) {
            try {
                // A savepoint isolates a failed SQL block even when a caller already has a transaction.
                $data = DB::transaction($calculation);
                $blocks[$key] = ['status' => 'READY', 'data' => $data, 'message' => null];
            } catch (Throwable $error) {
                if ($selected) {
                    Log::error('Selected profile calculation failed.', ['exception_type' => get_class($error)]);
                } else {
                    report($error);
                }
                $blocks[$key] = ['status' => 'ERROR', 'code' => 'BLOCK_CALCULATION_FAILED', 'data' => null, 'message' => 'Не удалось рассчитать блок. Остальные доступные показатели сохранены.'];
            }
        }
        $map = $this->area->forPoint($lon, $lat, $radiusM);
        if (in_array('transport', $wanted, true)) {
            $map['stops_in_radius'] = $blocks['transport']['data']['stops_in_radius'] ?? [];
        }
        foreach (OsmAreaKind::cases() as $kind) {
            if (! in_array($kind->value, $wanted, true)) {
                continue;
            }
            $block = $blocks[$kind->value];
            try {
                $map['area_layers'][$kind->value] = $block['status'] === 'ERROR' ? $block : [
                    'status' => 'READY', 'message' => null,
                    'data' => DB::transaction(fn () => $this->areaMap->forKind($kind, $snapshots[$kind->dataset()] ?? null, $block['data'], $lon, $lat, $radiusM)),
                ];
            } catch (Throwable $error) {
                if ($selected) {
                    Log::error('Selected profile calculation failed.', ['exception_type' => get_class($error)]);
                } else {
                    report($error);
                }
                $map['area_layers'][$kind->value] = ['status' => 'ERROR', 'code' => 'LAYER_CALCULATION_FAILED', 'data' => null, 'message' => 'Геометрия слоя недоступна. Показатели профиля сохранены.'];
            }
        }

        foreach (OsmLinearDataset::cases() as $dataset) {
            if (! in_array($dataset->value, $wanted, true)) {
                continue;
            }
            $block = $blocks[$dataset->value];
            try {
                $map['linear_layers'][$dataset->value] = $block['status'] === 'ERROR' ? $block : [
                    'status' => 'READY', 'message' => null,
                    'data' => DB::transaction(fn () => $this->linearMap->forDataset($dataset, $snapshots[$dataset->value] ?? null, $block['data'], $lon, $lat, $radiusM)),
                ];
            } catch (Throwable $error) {
                if ($selected) {
                    Log::error('Selected profile calculation failed.', ['exception_type' => get_class($error)]);
                } else {
                    report($error);
                }
                $map['linear_layers'][$dataset->value] = ['status' => 'ERROR', 'code' => 'LAYER_CALCULATION_FAILED', 'data' => null, 'message' => 'Линии слоя недоступны. Показатели профиля сохранены.'];
            }
        }

        return ($selected ? ['scope' => 'selected', 'profile_version' => 1, 'selected_blocks' => $wanted] : []) + ['address' => $address, 'point' => ['lon' => $lon, 'lat' => $lat], 'radius_m' => $radiusM,
            'calculated_at' => CarbonImmutable::now('UTC')->toIso8601String(), 'map' => $map, 'blocks' => $blocks];
    }
}
