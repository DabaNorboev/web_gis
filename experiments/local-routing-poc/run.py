"""Reproducible bounded Docker runner. Existing app containers/DB never modified."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
CODE = ROOT / 'experiments/local-routing-poc'
OUT = pathlib.Path(os.environ.get('PLACELENS_ROUTING_POC_OUTPUT', str(ROOT / 'data/reports/local-routing-2026-10-21'))).resolve()
VAL = 'ghcr.io/valhalla/valhalla@sha256:18cb42988e03c70dc4bc4ca095a259ec4db5e5df928be65956fc1c64c280b47a'
OSRM = 'ghcr.io/project-osrm/osrm-backend@sha256:855614a38f464b0558a2ad6eaa7cb8c139f39887da9b38b485ce453c6e6e6124'
BASE = ['docker', 'run', '--rm', '--network=none', '--read-only', '--memory=2g', '--memory-swap=2g', '--cpus=2', '--user=1000:1000', '--tmpfs=/tmp:rw,size=64m']


def command(args, key, timeout=600):
    began = time.monotonic()
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        for arg in args:
            if arg.startswith('--name=placelens-routing-build-'):
                subprocess.run(['docker', 'rm', '-f', arg.split('=', 1)[1]], capture_output=True)
        (OUT / (key + '.json')).write_text(json.dumps({'seconds': time.monotonic() - began, 'timeout': True, 'command': args}, indent=2) + '\n')
        raise
    (OUT / (key + '.log')).write_text(result.stdout + '\n' + result.stderr)
    metric = {'seconds': time.monotonic() - began, 'exit_code': result.returncode, 'command': args}
    (OUT / (key + '.json')).write_text(json.dumps(metric, indent=2) + '\n')
    print(key, metric['exit_code'], round(metric['seconds'], 3), flush=True)
    if result.returncode:
        raise RuntimeError(key + ': ' + result.stderr[-1600:])
    return result.stdout


def build(image, folder, args, key):
    # cgroup peak and CPU are read after the tool completes, while its cgroup exists.
    return command(BASE + ['--name=placelens-routing-build-' + key, '-v', f'{folder}:/work:rw', image, 'sh', '-c',
                           '"$@"; routing_exit=$?; cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/cpu.stat; exit "$routing_exit"', 'sh'] + args, key)


def probe(image, folder, server_args, engine, mode):
    name = 'placelens-routing-check-' + engine + '-' + mode
    args = BASE.copy()
    args.remove('--rm')
    args[args.index('--memory=2g')] = '--memory=1g'
    args[args.index('--memory-swap=2g')] = '--memory-swap=1g'
    subprocess.run(args + ['-d', '--name', name, '-v', f'{folder}:/work:ro', image] + server_args, check=True, capture_output=True)
    try:
        raw = command(['docker', 'run', '--rm', '--network=container:' + name, '--read-only', '--memory=128m', '--memory-swap=128m', '--cpus=1',
                       '-v', f'{CODE}:/experiment:ro', 'python:3.12-slim', 'python', '/experiment/probe.py', engine, mode], engine + '-' + mode + '-probe', 120)
        result = json.loads(raw)
        (OUT / (engine + '-' + mode + '-responses.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        metrics = subprocess.check_output(['docker', 'exec', name, 'sh', '-c', 'cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/cpu.stat'], text=True)
        inspection = json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]
        (OUT / (engine + '-' + mode + '-runtime.json')).write_text(json.dumps({'cgroup': metrics, 'network': inspection['HostConfig']['NetworkMode'],
            'ports': inspection['HostConfig']['PortBindings'], 'memory_limit': inspection['HostConfig']['Memory'], 'nano_cpus': inspection['HostConfig']['NanoCpus']}, indent=2) + '\n')
    finally:
        logs = subprocess.run(['docker', 'logs', name], capture_output=True, text=True)
        (OUT / (engine + '-' + mode + '-server.log')).write_text(logs.stdout + logs.stderr)
        subprocess.run(['docker', 'rm', '-f', name], check=True, capture_output=True)


def main():
    assert hashlib.sha256((CODE / 'controls.json').read_bytes()).hexdigest() == '27926bfefa29e9113c943cf2649097ede430a3c34b2c92361d56239c2a1b2e06'
    assert (OUT / 'prepared/extract-manifest.json').is_file(), 'Extract must complete first'
    for mode, profile in [('walking', 'foot'), ('driving', 'car')]:
        folder = OUT / ('osrm-' + mode)
        folder.mkdir(exist_ok=False)
        shutil.copyfile(OUT / 'prepared/pilot.osm.pbf', folder / 'pilot.osm.pbf')
        command(BASE + [OSRM, 'sh', '-c', 'cat /opt/' + profile + '.lua'], 'osrm-' + profile + '-profile')
        build(OSRM, folder, ['osrm-extract', '-t', '2', '-p', '/opt/' + profile + '.lua', '/work/pilot.osm.pbf'], 'osrm-' + mode + '-extract')
        build(OSRM, folder, ['osrm-partition', '-t', '2', '/work/pilot.osrm'], 'osrm-' + mode + '-partition')
        build(OSRM, folder, ['osrm-customize', '-t', '2', '/work/pilot.osrm'], 'osrm-' + mode + '-customize')
        probe(OSRM, folder, ['osrm-routed', '-t', '1', '--algorithm', 'mld', '/work/pilot.osrm'], 'osrm', mode)
    folder = OUT / 'valhalla'
    folder.mkdir(exist_ok=False)
    shutil.copyfile(OUT / 'prepared/pilot.osm.pbf', folder / 'pilot.osm.pbf')
    raw = command(BASE + [VAL, 'valhalla_build_config'], 'valhalla-default-config')
    config = json.loads(raw)
    config['mjolnir'].update({'tile_dir': '/work/tiles', 'tile_extract': '/work/tiles.tar', 'concurrency': 2,
                              'admin': '/work/absent-admin.sqlite', 'timezone': '/work/absent-timezone.sqlite'})
    config['httpd']['service']['listen'] = 'tcp://127.0.0.1:8002'
    (folder / 'valhalla.json').write_text(json.dumps(config, indent=2) + '\n')
    build(VAL, folder, ['valhalla_build_tiles', '-c', '/work/valhalla.json', '/work/pilot.osm.pbf'], 'valhalla-build')
    for mode in ['walking', 'driving']:
        probe(VAL, folder, ['valhalla_service', '/work/valhalla.json', '1'], 'valhalla', mode)


if __name__ == '__main__':
    main()
