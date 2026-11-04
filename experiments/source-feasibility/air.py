"""Normalize and draw actual A2 air observations. Naive source times stay naive."""
import argparse
import csv
import datetime as dt
import json
import math
from pathlib import Path
import statistics
import time

from PIL import Image, ImageDraw
from analyze import font, summary, write_json

START = dt.datetime(2026, 8, 9)
END = dt.datetime(2026, 8, 16)
SITES = [4228, 3846, 3858]
COLORS = [(30, 115, 185), (215, 85, 35), (70, 145, 65)]


def distance_m(a, b):
    # Diagnostic great-circle distance, mean Earth radius; not application GIS.
    lon1, lat1, lon2, lat2 = map(math.radians, [*a, *b])
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 2*6371008.8*math.asin(math.sqrt(h))


def load_api(path):
    data = json.loads(path.read_text())
    if data.get('status', {}).get('code', -1) < 0 or not isinstance(data.get('data'), (list, dict)):
        raise ValueError('API did not return actual data: '+path.name)
    return data['data']


def process(run, attempt):
    started = time.monotonic()
    output, figures = run/'derived'/attempt, run/'figures'/attempt
    output.mkdir(exist_ok=False)
    figures.mkdir(exist_ok=False)
    records = load_api(run/'raw/air-2026-week.json')
    project = load_api(run/'raw/air-project9-api.json')
    config = json.loads((run/'config.json').read_text())
    station_by_id = {s['id']: s for s in project['sites']}
    expected = [START+dt.timedelta(hours=i) for i in range(168)]
    series = {sid: {} for sid in SITES}
    duplicates, outside = [], []
    for row in records:
        stamp = dt.datetime.fromisoformat(row['time'])
        if row['site'] not in series or stamp < START or stamp >= END:
            outside.append(row)
            continue
        if stamp in series[row['site']]:
            duplicates.append({'site': row['site'], 'time': row['time']})
            continue
        series[row['site']][stamp] = row
    stations, normalized = [], []
    for sid in SITES:
        metadata = station_by_id[sid]
        points = series[sid]
        values = [v['pm25'] for v in points.values() if isinstance(v.get('pm25'), (int, float))]
        repeated_temp = sum(v.get('t') == -42.5 for v in points.values())
        station = {'id': sid, 'name': metadata['name'], 'source': 'КНЦ СО РАН / air.krasn.ru project 9',
                   'lon': metadata['geom_x'], 'lat': metadata['geom_y'], 'coordinates_crs': None,
                   'coordinates_crs_reason': 'lon/lat-shaped API values; datum/CRS not explicitly declared in project response',
                   'coordinate_history': None, 'equipment_history': None, 'quality_flags': None,
                   'metadata_begin_date': metadata.get('begin_date'), 'metadata_end_date': metadata.get('end_date'),
                   'distance_to_public_center_m_spherical': distance_m(config['public_center'], [metadata['geom_x'], metadata['geom_y']]),
                   'distance_assumption': 'diagnostic lon/lat on mean Earth sphere; source datum unconfirmed',
                   'pm25_units': 'µg/m³ according to operator help.html; field mapping confirmed in public client',
                   'timezone': None, 'timezone_reason': 'API returns timestamps without offset; no explicit timezone found',
                   'expected_query_hour_bins': len(expected), 'returned_rows': len(points),
                   'missing_rows': sum(t not in points for t in expected),
                   'missing_pm25': sum(t not in points or not isinstance(points[t].get('pm25'), (int, float)) for t in expected),
                   'pm25': summary(values), 'zero_pm25_count': values.count(0),
                   'repeated_august_temperature_minus_42_5_rows': repeated_temp,
                   'raw_record_fields': sorted(set().union(*(r.keys() for r in points.values())))}
        stations.append(station)
        for t in expected:
            value = points.get(t)
            normalized.append({'station_id': sid, 'time_raw': t.isoformat(sep=' '), 'time_utc': None,
                               'timezone': None, 'pm25_ug_m3': value.get('pm25') if value else None,
                               'temperature_c': value.get('t') if value else None,
                               'row_present': value is not None, 'quality_flag': None})
    report = {'requested_window_raw': [str(START), str(END)], 'end_exclusive': True,
              'time_basis': 'unaltered API clock; unknown timezone, no UTC normalization',
              'count_original_rows': len(records), 'duplicates': duplicates, 'outside_window': outside,
              'stations': stations, 'missing_plot_scope': 'availability of requested hourly API bins, not completeness of raw instrument readings',
              'history_probes': {name: {'rows': len(load_api(run/'raw'/name))} for name in ['air-2018-probe.json', 'air-2024-probe.json']}}
    assert len(records) == 504 and not duplicates and not outside
    assert len(normalized) == 504
    write_json(output/'air-summary.json', report)
    write_json(output/'air-normalized.json', normalized)
    with (output/'air-normalized.csv').open('x', newline='') as target:
        writer = csv.DictWriter(target, fieldnames=list(normalized[0]))
        writer.writeheader()
        writer.writerows(normalized)
    # Preserve three source-to-output audit examples without inventing QC or timezone.
    samples = []
    for sid in SITES:
        original = next(r for r in records if r['site'] == sid)
        projected = next(r for r in normalized if r['station_id'] == sid and r['time_raw'] == original['time'])
        assert original['pm25'] == projected['pm25_ug_m3']
        samples.append({'original': original, 'normalized': projected})
    write_json(output/'air-source-output-checks.json', samples)
    canvas = Image.new('RGB', (1320, 830), 'white')
    draw = ImageDraw.Draw(canvas)
    draw.text((45, 20), 'Реальные измерения PM2.5 — 9–15 августа 2026', font=font(27), fill='black')
    draw.text((45, 60), 'Источник: air.krasn.ru / КНЦ СО РАН. Время API; часовой пояс не подтверждён.', font=font(18), fill='black')
    left, top, width, height = 90, 125, 1180, 465
    ymax = math.ceil(max(s['pm25']['max'] for s in stations)/10)*10
    for k in range(6):
        y = top+height-height*k/5
        draw.line((left, y, left+width, y), fill=(220, 220, 220))
        draw.text((12, y-10), f'{ymax*k/5:g}', font=font(17), fill='black')
    draw.text((10, 95), 'мкг/м³', font=font(17), fill='black')
    for day in range(8):
        x = left+width*day/7
        draw.line((x, top, x, top+height), fill=(235, 235, 235))
        draw.text((x-22, top+height+12), f'{day+9:02}.08', font=font(17), fill='black')
    for si, sid in enumerate(SITES):
        previous = None
        for index, t in enumerate(expected):
            value = series[sid].get(t, {}).get('pm25')
            if not isinstance(value, (int, float)):
                previous = None
                continue
            point = (left+width*index/168, top+height-value/ymax*height)
            if previous:
                draw.line((previous, point), fill=COLORS[si], width=2)
            previous = point
        draw.text((left+si*390, 662), f"{sid}: {station_by_id[sid]['name']}", font=font(18), fill=COLORS[si])
    notes = ['504 записи: 3 станции × 168 часовых интервалов. Нет интерполяции на дома.',
             'Флаги качества и история оборудования не предоставлены; график не подтверждает точность датчиков.',
             'В полях температуры найдены повторяющиеся −42,5 °C; PM2.5 автоматически не исправлялся.']
    for i, note in enumerate(notes):
        draw.text((45, 715+i*30), note, font=font(18), fill='black')
    canvas.save(figures/'air-measurements.png')
    gap = Image.new('RGB', (1320, 580), 'white')
    d = ImageDraw.Draw(gap)
    d.text((40, 22), 'Наличие часовых значений PM2.5 в запрошенном окне', font=font(24), fill='black')
    for si, sid in enumerate(SITES):
        y = 95+si*100
        d.text((40, y), f"{sid}: {station_by_id[sid]['name']}", font=font(19), fill='black')
        for index, t in enumerate(expected):
            present = isinstance(series[sid].get(t, {}).get('pm25'), (int, float))
            x = 40+index*1240/168
            d.rectangle((x, y+30, x+1240/168-1, y+65), fill=(40, 145, 100) if present else (200, 65, 60))
    for day in range(8):
        d.text((40+day*1240/7-4, 405), f'{day+9:02}.08', font=font(17), fill='black')
    d.text((40, 455), 'Зелёное: значение есть; красное: пропуск. В этом окне пропусков PM2.5 не найдено.', font=font(18), fill='black')
    d.text((40, 488), 'Это сетка ответа API, а не доказанная полнота исходных измерений. Качество неизвестно.', font=font(18), fill='black')
    d.text((40, 521), 'Часовой пояс не указан источником; временные метки сохранены без перевода в UTC.', font=font(18), fill='black')
    gap.save(figures/'air-gaps.png')
    write_json(output/'air-processing-cost.json', {'elapsed_seconds': time.monotonic()-started})
    print(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--attempt', default='air-v1')
    args = parser.parse_args()
    process(args.run, args.attempt)
