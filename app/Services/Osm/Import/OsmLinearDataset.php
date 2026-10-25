<?php

namespace App\Services\Osm\Import;

enum OsmLinearDataset: string
{
    case Roads = 'roads';
    case Railways = 'railways';

    public function table(): string
    {
        return 'osm_'.$this->value;
    }

    public function tag(): string
    {
        return $this === self::Roads ? 'highway' : 'railway';
    }

    public function types(): array
    {
        return $this === self::Roads ? ['motorway', 'trunk', 'primary', 'secondary'] : ['rail', 'narrow_gauge'];
    }
}
