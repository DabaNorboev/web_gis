<?php

namespace App\Services\Osm\Analysis;

enum OsmAreaKind: string
{
    case Parks = 'parks';
    case Vegetation = 'vegetation';
    case Water = 'water';

    public function dataset(): string
    {
        return $this === self::Water ? 'water' : 'green_areas';
    }

    public function table(): string
    {
        return $this === self::Water ? 'osm_water' : 'osm_green_areas';
    }

    public function predicate(): string
    {
        return match ($this) {
            self::Parks => 'a.is_park',
            self::Vegetation => 'a.is_vegetation',
            self::Water => 'true',
        };
    }

    public function limitation(): string
    {
        return match ($this) {
            self::Parks => 'Границы объектов leisure=park по OSM, включая возможные дорожки, здания и воду. Сады не объявляются парками. Наличие контура не подтверждает общественный доступ или удобный вход.',
            self::Vegetation => 'Территории с согласованными растительными тегами natural/landuse по OSM. Это картографическая площадь, не измеренная доля растительности и не NDVI; наличие границы парка само по себе не учитывается.',
            self::Water => 'Водные площади по OSM. Сезонность, постоянное наличие воды и доступ к берегу не подтверждены.',
        };
    }
}
