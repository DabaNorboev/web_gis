"""Bounded sequential ORS experiment. No Compose, application or DB operations."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
CODE = Path(__file__).resolve().parent
IMAGE = 'heigit/openrouteservice@sha256:e63d4df17a8df5fa1c0432c27b0c361be33e6f21a7b28496e97b6434b5954ce1'
PBF = ROOT / 'data/reports/local-routing-2026-10-21/prepared/pilot.osm.pbf'
CONTROLS = ROOT / 'experiments/local-routing-poc/controls.json'
HELPER = 'python:3.12-slim'


def docker(*args, **kwargs):
    kwargs.setdefault('timeout', 30)
    return subprocess.run(['docker', *args], check=True, capture_output=True, text=True, **kwargs).stdout


def remove_owned(container_id, errors):
    """Remove only a container ID returned by our own successful create call."""
    try:
        docker('rm', '-f', container_id)
    except Exception as error:
        errors.append({'container_id': container_id, 'error_class': type(error).__name__})


def helper(name, options, image, arguments, timeout, cleanup_errors):
    container_id = None
    try:
        container_id = docker('create', '--name', name, *options, image, *arguments).strip()
        return docker('start', '--attach', container_id, timeout=timeout)
    finally:
        if container_id:
            remove_owned(container_id, cleanup_errors)


def text_output(value):
    # TimeoutExpired can contain bytes even when subprocess was called with text=True.
    return value.decode(errors='replace') if isinstance(value, bytes) else value


def config(profile):
    car = profile == 'driving-car'
    return f'''server:
  port: 8082
  servlet:
    context-path: /ors
logging:
  level:
    root: WARN
    org.heigit: INFO
ors:
  engine:
    init_threads: 1
    profile_default:
      graph_path: /home/ors/graphs
      build:
        source_file: /input/pilot.osm.pbf
        elevation: false
    profiles:
      driving-car:
        enabled: {str(car).lower()}
        build:
          elevation: false
          encoder_options:
            turn_costs: true
          ext_storages:
            OsmId: {{}}
            RoadAccessRestrictions:
              use_for_warnings: true
      foot-walking:
        enabled: {str(not car).lower()}
        build:
          elevation: false
          ext_storages:
            OsmId: {{}}
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['walking', 'driving'])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    freeze = json.loads((out / 'freeze.json').read_text())
    for path, meta in freeze['inputs'].items():
        if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != meta['sha256']:
            raise ValueError('Frozen input hash mismatch: ' + path)
    folder = out / args.mode
    folder.mkdir(exist_ok=False)
    home = folder / 'home'
    home.mkdir()
    (home / 'graphs').mkdir()
    profile = {'walking': 'foot-walking', 'driving': 'driving-car'}[args.mode]
    cfg = folder / 'ors-config.yml'
    cfg.write_text(config(profile))
    name = 'placelens-ors-poc-' + args.mode + '-' + uuid.uuid4().hex[:12]
    began = time.monotonic()
    container_id = None
    failed = False
    result = {'mode': args.mode, 'image': IMAGE, 'cleanup_errors': [], 'collection_errors': [],
              'source_sha256': hashlib.sha256(PBF.read_bytes()).hexdigest(), 'profile': profile}
    command = ['create', '--name', name, '--network=none', '--read-only', '--memory=3g',
               '--memory-swap=3g', '--cpus=2', '--user=1000:1000', '--cap-drop=ALL',
               '--security-opt=no-new-privileges:true', '--tmpfs=/tmp:rw,size=128m,mode=1777',
               '-v', f'{home}:/home/ors:rw', '-v', f'{cfg}:/config/ors-config.yml:ro',
               '-v', f'{PBF}:/input/pilot.osm.pbf:ro',
               '-e', 'ORS_CONFIG_LOCATION=/config/ors-config.yml', '-e', 'ORS_HOME=/home/ors',
               '--entrypoint', 'java', IMAGE, '-Xms256m', '-Xmx2g', '-XX:ActiveProcessorCount=2',
               '-jar', '/ors.jar']
    result['command'] = ['docker', *command]
    try:
        # Execute the same immutable helper ID we record, rather than its mutable tag.
        helper_image = docker('image', 'inspect', HELPER, '--format', '{{.Id}}').strip()
        result['helper_image_id'] = helper_image
        container_id = docker(*command).strip()
        result['container_id'] = container_id
        docker('start', container_id)
        wait_code = '''import json,time,urllib.request,sys
start=time.monotonic()
while time.monotonic()-start<590:
 try:
  with urllib.request.urlopen("http://127.0.0.1:8082/ors/v2/health",timeout=2) as r:
   body=json.load(r)
   if body.get("status")=="ready":
    print(json.dumps({"ready":True,"health":body,"seconds":time.monotonic()-start}));sys.exit(0)
 except Exception: pass
 time.sleep(2)
print(json.dumps({"ready":False,"seconds":time.monotonic()-start}));sys.exit(1)
'''
        ready = helper(name + '-ready', ['--network=container:' + container_id, '--read-only',
                       '--memory=64m', '--memory-swap=64m', '--cpus=0.5'], helper_image,
                       ['python', '-c', wait_code], 600, result['cleanup_errors'])
        result['readiness'] = json.loads(ready)
        result['build_and_start_wall_seconds'] = time.monotonic() - began
        result['ready_cgroup'] = docker('exec', container_id, 'sh', '-c',
                                      'cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/cpu.stat')
        raw = helper(name + '-probe', ['--network=container:' + container_id, '--read-only',
                     '--memory=128m', '--memory-swap=128m', '--cpus=1',
                     '-v', f'{CODE}:/experiment:ro', '-v', f'{CONTROLS}:/controls.json:ro'],
                     helper_image, ['python', '-B', '/experiment/probe.py', args.mode],
                     180, result['cleanup_errors'])
        json.loads(raw)
        (folder / 'responses.json').write_text(raw)
        result['outcome'] = 'PROBED'
    except Exception as error:
        failed = True
        result.update(outcome='FAILED', error_class=type(error).__name__,
                      error_stdout=text_output(getattr(error, 'stdout', None)),
                      error_stderr=text_output(getattr(error, 'stderr', None)))
        raise
    finally:
        if container_id:
            # Optional diagnostics must never prevent container removal or hide the original failure.
            try:
                result['final_cgroup'] = docker('exec', container_id, 'sh', '-c',
                                               'cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/cpu.stat')
            except Exception as error:
                result['collection_errors'].append({'step': 'cgroup', 'error_class': type(error).__name__})
            try:
                inspection = json.loads(docker('inspect', container_id))[0]
                result['isolation'] = {k: inspection['HostConfig'].get(k) for k in
                                       ['NetworkMode', 'PortBindings', 'Memory', 'MemorySwap', 'NanoCpus', 'ReadonlyRootfs']}
            except Exception as error:
                result['collection_errors'].append({'step': 'inspect', 'error_class': type(error).__name__})
            try:
                logs = subprocess.run(['docker', 'logs', container_id], capture_output=True, text=True,
                                      timeout=30, check=True)
                (folder / 'server.log').write_text(logs.stdout + logs.stderr)
            except Exception as error:
                result['collection_errors'].append({'step': 'logs', 'error_class': type(error).__name__})
            finally:
                remove_owned(container_id, result['cleanup_errors'])
        result['total_wall_seconds'] = time.monotonic() - began
        try:
            graph_files = [p for p in (home / 'graphs').rglob('*') if p.is_file()]
            result['graph_bytes'] = sum(p.stat().st_size for p in graph_files)
            result['graph_hashes'] = {str(p.relative_to(home)): hashlib.sha256(p.read_bytes()).hexdigest() for p in graph_files}
        except Exception as error:
            result['collection_errors'].append({'step': 'graph_hashes', 'error_class': type(error).__name__})
        if result['cleanup_errors'] and not failed:
            result['outcome'] = 'CLEANUP_FAILED'
        (folder / 'runtime.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({k: result.get(k) for k in ['mode', 'outcome', 'build_and_start_wall_seconds', 'graph_bytes']}), flush=True)
        if result['cleanup_errors'] and not failed:
            raise RuntimeError('Experiment container cleanup failed; inspect runtime.json')


if __name__ == '__main__':
    main()
