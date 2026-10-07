<?php

namespace App\Services\Transport\Import;

use RuntimeException;

class OfficialStopsCsvReader
{
    private const COLUMNS = ['id', 'name', 'type_transport', 'num_route', 'address', 'the_geom_lon', 'the_geom_lat'];

    public function read(string $contents): array
    {
        if (! mb_check_encoding($contents, 'UTF-8')) {
            throw new RuntimeException('CSV must use UTF-8 encoding.');
        }

        $stream = fopen('php://temp', 'w+');
        try {
            fwrite($stream, $contents);
            rewind($stream);
            $header = fgetcsv($stream, escape: '');
            if ($header === false) {
                throw new RuntimeException('CSV is empty.');
            }
            $header[0] = preg_replace('/^\xEF\xBB\xBF/', '', $header[0]);
            if (count($header) !== count(self::COLUMNS) || array_diff(self::COLUMNS, $header)) {
                throw new RuntimeException('Unexpected CSV columns; expected: '.implode(', ', self::COLUMNS));
            }

            $rows = [];
            $seen = [];
            $record = 1;
            while (($values = fgetcsv($stream, escape: '')) !== false) {
                $record++;
                if ($values === [null]) {
                    continue;
                }
                if (count($values) !== count($header)) {
                    throw new RuntimeException("CSV record $record has an unexpected number of fields.");
                }
                $raw = array_combine($header, $values);
                $id = trim($raw['id']);
                if ($id === '' || strlen($id) > 255 || isset($seen[$id])) {
                    throw new RuntimeException("Missing, invalid or duplicate stop ID at CSV record $record.");
                }
                $seen[$id] = true;
                $lon = $this->coordinate($raw['the_geom_lon'], 180);
                $lat = $this->coordinate($raw['the_geom_lat'], 90);
                $rows[] = ['source_id' => $id, 'lon' => $lon, 'lat' => $lat, 'raw' => $raw];
            }

            return $rows;
        } finally {
            fclose($stream);
        }
    }

    private function coordinate(string $value, int $limit): ?float
    {
        $value = trim($value);
        if ($value === '' || ! is_numeric($value)) {
            return null;
        }
        $number = (float) $value;

        return is_finite($number) && abs($number) <= $limit ? $number : null;
    }
}
