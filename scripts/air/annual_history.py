"""Accumulate verified hourly air observations independently of snapshot retention."""

import calendar
from contextlib import closing
import json
import sqlite3


SCHEMA = """
CREATE TABLE IF NOT EXISTS archive_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    end_exclusive TEXT NOT NULL,
    snapshot_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
    source TEXT NOT NULL,
    station_id TEXT NOT NULL,
    observed_at_raw TEXT NOT NULL,
    indicator TEXT NOT NULL CHECK (indicator IN ('pm2_5', 'pm10')),
    value REAL,
    field_present INTEGER NOT NULL CHECK (field_present IN (0, 1)),
    snapshot_version TEXT NOT NULL,
    raw_references TEXT NOT NULL,
    PRIMARY KEY (source, station_id, observed_at_raw, indicator)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS observations_by_hour ON observations (observed_at_raw);
CREATE TABLE IF NOT EXISTS revisions (
    source TEXT NOT NULL,
    station_id TEXT NOT NULL,
    observed_at_raw TEXT NOT NULL,
    indicator TEXT NOT NULL,
    value REAL,
    field_present INTEGER NOT NULL,
    snapshot_version TEXT NOT NULL,
    raw_references TEXT NOT NULL,
    replaced_by TEXT NOT NULL,
    FOREIGN KEY (source, station_id, observed_at_raw, indicator)
        REFERENCES observations (source, station_id, observed_at_raw, indicator) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS revisions_by_observation
    ON revisions (source, station_id, observed_at_raw, indicator);
CREATE TRIGGER IF NOT EXISTS save_previous_observation BEFORE UPDATE ON observations
BEGIN
    INSERT INTO revisions VALUES (
        OLD.source, OLD.station_id, OLD.observed_at_raw, OLD.indicator, OLD.value,
        OLD.field_present, OLD.snapshot_version, OLD.raw_references, NEW.snapshot_version
    );
END;
"""

UPSERT = """
INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (source, station_id, observed_at_raw, indicator) DO UPDATE SET
    value = excluded.value,
    field_present = excluded.field_present,
    snapshot_version = excluded.snapshot_version,
    raw_references = excluded.raw_references
WHERE excluded.field_present = 1
  AND (observations.field_present = 0 OR observations.value IS NOT excluded.value)
"""


def archive_rows(release, pin, manifest, snapshot):
    raw_path = 'raw/hourly.json'
    raw_product = 'input/' + raw_path
    hashes = {entry['path']: entry['sha256'] for entry in manifest['files']}
    raw_pm10 = None
    if raw_product in hashes:
        raw_pm10 = snapshot.envelope(snapshot.decode((release / raw_product).read_bytes()))

    pm10_rows, invalid_pm10 = [], set()
    with (release / 'observations.jsonl').open('rb') as stream:
        for line in stream:
            row = snapshot.decode(line)
            key = (row['source'], row['station_id'], row['observed_at_raw'])
            refs = [ref | {'sha256': hashes['input/' + ref['raw_file']]} for ref in row['raw_references']]
            yield (*key, 'pm2_5', row['value'], any(ref['value_field_present'] for ref in refs),
                   pin, json.dumps(refs, separators=(',', ':')))
            if raw_pm10 is None:
                continue
            pm10_refs = [ref | {'value_field_present': 'pm10' in raw_pm10[ref['raw_index']]}
                         for ref in refs if ref['raw_file'] == raw_path]
            try:
                values = {snapshot.numeric(raw_pm10[ref['raw_index']].get('pm10')) for ref in pm10_refs}
                snapshot.require(len(values) == 1, 'Conflicting PM10 values')
                value, = values
                snapshot.require(value is None or value >= 0, 'Negative PM10 value')
            except ValueError:
                invalid_pm10.add(row['station_id'])
                continue
            pm10_rows.append((*key, 'pm10', value, any(ref['value_field_present'] for ref in pm10_refs),
                              pin, json.dumps(pm10_refs, separators=(',', ':'))))
    yield from (row for row in pm10_rows if row[1] not in invalid_pm10)


def record(database, release, pin, manifest, snapshot):
    end_raw = manifest['window_raw']['end_exclusive']
    end = snapshot.hour(end_raw)
    year = max(1, end.year - 1)
    day = min(end.day, calendar.monthrange(year, end.month)[1])
    cutoff = end.replace(year=year, day=day).isoformat(sep=' ')
    if database.is_symlink() or (database.exists() and not database.is_file()):
        raise OSError('Invalid air archive path')
    with closing(sqlite3.connect(database)) as connection:
        connection.execute('PRAGMA foreign_keys = ON')
        connection.executescript(SCHEMA)
        with connection:
            connection.execute('BEGIN IMMEDIATE')
            previous = connection.execute(
                'SELECT end_exclusive, snapshot_version FROM archive_state WHERE id = 1'
            ).fetchone()
            if previous is not None and (end_raw < previous[0] or pin == previous[1]):
                return
            connection.executemany(UPSERT, archive_rows(release, pin, manifest, snapshot))
            connection.execute('DELETE FROM observations WHERE observed_at_raw < ?', (cutoff,))
            connection.execute('REPLACE INTO archive_state VALUES (1, ?, ?)', (end_raw, pin))
