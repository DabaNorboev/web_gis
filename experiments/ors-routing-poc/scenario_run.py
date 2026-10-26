"""Run frozen public walking scenarios against a private copy of the old graph.

Never mounts the source graph into a container. Only a fresh runtime directory is
writable; all reused inputs are frozen and verified before invoking Docker.
"""
import argparse
import json
from pathlib import Path
import shutil
import time
import uuid

import run as original
from review_support import digest, write
from scenario_probe import validate_scenarios


SOURCE_WALKING = original.ROOT / 'data/reports/ors-routing-poc-2026-10-26/walking'
POLICY = original.CODE / 'walking-policy.json'
NEW_LOCK_FILES = {'foot-walking/gh.lock'}


def graph_hashes(graphs):
    if not graphs.is_dir():
        raise ValueError('Source walking graph is missing')
    paths = sorted(graphs.rglob('*'))
    if any(path.is_symlink() for path in paths):
        raise ValueError('Graph symlinks are not accepted')
    hashes = {str(path.relative_to(graphs)): digest(path) for path in paths if path.is_file()}
    if not hashes:
        raise ValueError('Source walking graph is empty')
    return hashes


def verify_stopped_graphs(source_graphs, copied_graphs, before):
    source_after = graph_hashes(source_graphs)
    copied_after = graph_hashes(copied_graphs)
    changed = sorted(path for path, checksum in before.items() if copied_after.get(path) != checksum)
    added = set(copied_after) - before.keys()
    unexpected = sorted(added - NEW_LOCK_FILES)
    return {'source_after': source_after, 'source_unchanged': source_after == before,
            'copy_after_stop': copied_after, 'copy_changed_or_missing_files': changed,
            'copy_new_lock_files': sorted(added & NEW_LOCK_FILES),
            'copy_unexpected_files': unexpected,
            'copy_verified': not changed and not unexpected}


def prepare(output, scenarios, source_walking):
    """Validate every input before creating fresh runtime storage or using Docker."""
    runtime = output / 'runtime'
    if runtime.exists():
        raise FileExistsError('Runtime directory already exists')
    freeze = json.loads((output / 'scenario-freeze.json').read_text())
    for path, key in ((scenarios, 'scenarios_sha256'), (original.PBF, 'pbf_sha256'), (POLICY, 'policy_sha256')):
        if digest(path) != freeze[key]:
            raise ValueError('Frozen input hash mismatch: ' + key)
    cases = validate_scenarios(json.loads(scenarios.read_text()))
    graphs = source_walking / 'home/graphs'
    before = graph_hashes(graphs)
    if before != freeze['graph_hashes']:
        raise ValueError('Frozen source graph hash mismatch')
    required = {'foot-walking/' + name for name in
                ('edges', 'nodes', 'geometry', 'properties', 'graph_build_info.yml')}
    if not required <= before.keys():
        raise ValueError('Expected a complete existing foot-walking graph')
    # Ancestor/descendant output paths could contaminate the historical graph.
    if runtime == graphs or runtime in graphs.parents or graphs in runtime.parents:
        raise ValueError('Runtime must be separate from the source graph')
    runtime.mkdir(exist_ok=False)
    try:
        home = runtime / 'home'
        home.mkdir()
        shutil.copytree(graphs, home / 'graphs')
        copied = graph_hashes(home / 'graphs')
        after = graph_hashes(graphs)
        verification = {'source_before': before, 'copy_before_start': copied,
                        'source_after_copy': after,
                        'source_unchanged_after_copy': after == before,
                        'copy_matches_frozen_source': copied == before}
        write(runtime / 'source-graph-before.json', verification)
        if copied != before or after != before:
            raise ValueError('Graph copy or source preservation verification failed')
        # Helpers see this verified snapshot, not a separately mutable input path.
        with (runtime / 'scenarios.json').open('xb') as stream:
            stream.write(scenarios.read_bytes())
        if digest(runtime / 'scenarios.json') != freeze['scenarios_sha256']:
            raise ValueError('Scenario input changed during copy')
        with (runtime / 'ors-config.yml').open('x') as stream:
            stream.write(original.config('foot-walking'))
        return runtime, before, {case['id'] + '-' + variant for case in cases
                                 for variant in ('original', 'selected')}
    except Exception as error:
        write(runtime / 'preparation-failure.json', {'error_class': type(error).__name__})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--scenarios', type=Path, required=True)
    parser.add_argument('--source-walking', type=Path, default=SOURCE_WALKING)
    args = parser.parse_args()
    output, scenarios, source_walking = args.output.resolve(), args.scenarios.resolve(), args.source_walking.resolve()
    runtime, before, expected_ids = prepare(output, scenarios, source_walking)
    home, cfg = runtime / 'home', runtime / 'ors-config.yml'
    name = 'placelens-walking-scenario-' + uuid.uuid4().hex[:12]
    container_id, failed = None, False
    began = time.monotonic()
    result = {'mode': 'walking', 'profile': 'foot-walking', 'image': original.IMAGE,
              'graph_mode': 'COPY_EXISTING_GRAPH', 'cleanup_errors': [], 'collection_errors': []}
    command = ['create', '--name', name, '--network=none', '--read-only', '--memory=3g',
               '--memory-swap=3g', '--cpus=2', '--user=1000:1000', '--cap-drop=ALL',
               '--security-opt=no-new-privileges:true', '--tmpfs=/tmp:rw,size=128m,mode=1777',
               '-v', f'{home}:/home/ors:rw', '-v', f'{cfg}:/config/ors-config.yml:ro',
               '-v', f'{original.PBF}:/input/pilot.osm.pbf:ro',
               '-e', 'ORS_CONFIG_LOCATION=/config/ors-config.yml', '-e', 'ORS_HOME=/home/ors',
               '--entrypoint', 'java', original.IMAGE, '-Xms256m', '-Xmx2g', '-XX:ActiveProcessorCount=2',
               '-jar', '/ors.jar']
    result['command'] = ['docker', *command]
    try:
        # Require the existing pinned image; this experiment never pulls/builds.
        result['image_id'] = original.docker('image', 'inspect', original.IMAGE, '--format', '{{.Id}}').strip()
        helper_image = original.docker('image', 'inspect', original.HELPER, '--format', '{{.Id}}').strip()
        result['helper_image_id'] = helper_image
        container_id = original.docker(*command).strip()
        result['container_id'] = container_id
        original.docker('start', container_id)
        wait_code = '''import json,time,urllib.request,sys
start=time.monotonic()
while time.monotonic()-start<590:
 try:
  with urllib.request.urlopen("http://127.0.0.1:8082/ors/v2/health",timeout=2) as r:
   body=json.load(r)
   if body.get("status")=="ready":
    print(json.dumps({"ready":True,"seconds":time.monotonic()-start}));sys.exit(0)
 except Exception: pass
 time.sleep(2)
sys.exit(1)
'''
        ready = original.helper(name + '-ready', ['--network=container:' + container_id, '--read-only',
                                '--memory=64m', '--memory-swap=64m', '--cpus=0.5'], helper_image,
                                ['python', '-c', wait_code], 600, result['cleanup_errors'])
        result['readiness'] = json.loads(ready)
        result['load_and_start_wall_seconds'] = time.monotonic() - began
        raw = original.helper(name + '-probe', ['--network=container:' + container_id, '--read-only',
                              '--memory=128m', '--memory-swap=128m', '--cpus=1',
                              '-v', f'{original.CODE}:/experiment:ro',
                              '-v', f'{runtime / "scenarios.json"}:/scenarios.json:ro'],
                              helper_image, ['python', '-B', '/experiment/scenario_probe.py'],
                              120, result['cleanup_errors'])
        response = json.loads(raw)
        rows = response['rows']
        if response.get('mode') != 'walking' or len(rows) != len(expected_ids) or {row['id'] for row in rows} != expected_ids:
            raise ValueError('Expected both variants of every frozen scenario')
        write(runtime / 'responses.json', response)
        result['outcome'] = 'PROBED'
    except Exception as error:
        failed = True
        result.update(outcome='FAILED', error_class=type(error).__name__,
                      error_stdout=original.text_output(getattr(error, 'stdout', None)),
                      error_stderr=original.text_output(getattr(error, 'stderr', None)))
        raise
    finally:
        if container_id:
            for step, command_args in (
                    ('cgroup', ('exec', container_id, 'sh', '-c', 'cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/cpu.stat')),
                    ('inspect', ('inspect', container_id)), ('logs', ('logs', container_id))):
                try:
                    if step == 'logs':
                        logs = original.subprocess.run(['docker', *command_args], capture_output=True,
                                                       text=True, timeout=30, check=True)
                        with (runtime / 'server.log').open('x') as stream:
                            stream.write(logs.stdout + logs.stderr)
                    else:
                        diagnostic = original.docker(*command_args)
                        if step == 'inspect':
                            config = json.loads(diagnostic)[0]['HostConfig']
                            result['isolation'] = {key: config.get(key) for key in
                                                   ('NetworkMode', 'PortBindings', 'Memory', 'MemorySwap', 'NanoCpus', 'ReadonlyRootfs')}
                        else:
                            result['final_cgroup'] = diagnostic
                except Exception as error:
                    result['collection_errors'].append({'step': step, 'error_class': type(error).__name__})
            original.remove_owned(container_id, result['cleanup_errors'])
        preservation_failed = False
        try:
            verification = verify_stopped_graphs(source_walking / 'home/graphs', home / 'graphs', before)
            write(runtime / 'source-graph-after.json', verification)
            result['source_graph_unchanged'] = verification['source_unchanged']
            result['copy_graph_verified'] = verification['copy_verified']
            preservation_failed = not verification['source_unchanged'] or not verification['copy_verified']
        except Exception as error:
            preservation_failed = True
            result['collection_errors'].append({'step': 'graph_preservation', 'error_class': type(error).__name__})
        result['total_wall_seconds'] = time.monotonic() - began
        if result['cleanup_errors'] or preservation_failed:
            result['outcome'] = 'CLEANUP_OR_PRESERVATION_FAILED'
        write(runtime / 'runtime.json', result)
        print(json.dumps({key: result.get(key) for key in
                          ('mode', 'outcome', 'load_and_start_wall_seconds', 'source_graph_unchanged')}), flush=True)
        if not failed and (result['cleanup_errors'] or preservation_failed):
            raise RuntimeError('Scenario cleanup or source preservation failed; inspect runtime.json')


if __name__ == '__main__':
    main()
