<?php

namespace App\Services\Osm\Import;

enum OsmAreaDataset: string
{
    case GreenAreas = 'green_areas';
    case Water = 'water';

    public function table(): string
    {
        return 'osm_'.$this->value;
    }

    public function rules(): array
    {
        return $this === self::GreenAreas
            ? ['natural' => ['wood', 'scrub', 'grassland', 'heath'], 'landuse' => ['forest', 'grass', 'meadow', 'village_green', 'orchard'], 'leisure' => ['park', 'garden']]
            : ['natural' => ['water'], 'waterway' => ['riverbank'], 'landuse' => ['reservoir']];
    }

    public function classify(array $tags): ?array
    {
        // Primary import tag only. Product categories use independent generated flags in osm_green_areas.
        foreach ($this->rules() as $key => $values) {
            if (in_array($tags[$key] ?? '', $values, true)) {
                return ['feature_type' => $key.':'.$tags[$key], 'representation' => $this === self::Water ? 'water_area' : ($key === 'leisure' ? 'recreation_boundary' : 'vegetation_landuse')];
            }
        }

        return null;
    }
}
