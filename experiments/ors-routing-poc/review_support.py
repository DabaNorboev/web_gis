"""File-only helpers for the attributed historical checker; no runtime actions."""
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPORT = Path('data/reports/local-routing-2026-10-21')
GUARDS = Path('data/reports/local-routing-integration-2026-10-21/guard-export')


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for part in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def write(path, value):
    with Path(path).open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')
