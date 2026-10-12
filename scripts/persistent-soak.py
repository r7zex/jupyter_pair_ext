#!/usr/bin/env python3
"""Detached, observable CPU soak using the production loopback broker and agent.

An explicit number of training steps is the algorithmic completion condition.
There is no elapsed-time execution deadline. The default workload lasts at least
four hours, excluding process preparation; status reports actual elapsed time.
The local workspace must remain available after the chat/editor closes.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


TRAINING = r'''import hashlib, json, math, os, random, time
from pathlib import Path

def atomic(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)

root = Path(os.environ['PAIR_NOTEBOOK_WORKSPACE'])
config_bytes = (Path.cwd() / 'soak-config.json').read_bytes()
config = json.loads(config_bytes)
data_bytes = (root / 'owner-synthetic-data.json').read_bytes()
assert hashlib.sha256(data_bytes).hexdigest() == config['datasetSha256']
rows = json.loads(data_bytes)
run_id = os.environ['PAIR_NOTEBOOK_JOB_ID']
artifacts = root / 'artifacts' / run_id
artifacts.mkdir(parents=True, exist_ok=True)
started = time.time()
atomic(artifacts / 'process.json', {'pid': os.getpid(), 'startedAt': started, 'runId': run_id})
with (root / 'launches.jsonl').open('a', encoding='utf-8') as stream:
    stream.write(json.dumps({'runId': run_id, 'pid': os.getpid(), 'startedAt': started}) + '\n')
    stream.flush()
    os.fsync(stream.fileno())
random.seed(config['seed'])
weights, velocity = [0.0] * 5, [0.0] * 5
loss, correct = 0.0, 0
print('CPU_SOAK_STARTED ' + run_id, flush=True)
for step in range(1, config['steps'] + 1):
    before = time.monotonic()
    for update in range(config['updatesPerStep']):
        gradient, loss, correct = [0.0] * 5, 0.0, 0
        for row in rows:
            x, y = row['features'] + [1.0], row['label']
            logit = max(-40.0, min(40.0, sum(w * v for w, v in zip(weights, x))))
            probability = 1.0 / (1.0 + math.exp(-logit))
            loss += -(y * math.log(max(probability, 1e-12)) + (1-y) * math.log(max(1-probability, 1e-12)))
            correct += int((probability >= 0.5) == bool(y))
            for index in range(5):
                gradient[index] += (probability - y) * x[index] / len(rows)
        for index in range(5):
            velocity[index] = 0.8 * velocity[index] + gradient[index]
            weights[index] -= 0.02 * velocity[index]
    # This pacing is explicitly configured, never an execution timeout.
    time.sleep(max(0.0, config['minimumStepSeconds'] - (time.monotonic() - before)))
    metric = {'runId': run_id, 'step': step, 'globalUpdate': step * config['updatesPerStep'],
              'elapsedSeconds': time.time() - started, 'loss': loss / len(rows),
              'syntheticAccuracy': correct / len(rows), 'timestamp': time.time()}
    with (artifacts / 'metrics.jsonl').open('a', encoding='utf-8') as stream:
        stream.write(json.dumps(metric, sort_keys=True) + '\n')
    atomic(artifacts / 'progress.json', metric)
    if step % config['checkpointEverySteps'] == 0 or step == config['steps']:
        checkpoint = {'format': 'pair-soak-stdlib-v1', 'runId': run_id, 'step': step,
                      'model': weights, 'optimizerVelocity': velocity, 'pythonRandomState': random.getstate(),
                      'configSha256': hashlib.sha256(config_bytes).hexdigest(),
                      'datasetSha256': config['datasetSha256'], 'timestamp': time.time()}
        current, previous = artifacts / 'resume.json', artifacts / 'resume.previous.json'
        if current.exists():
            atomic(previous, json.loads(current.read_text(encoding='utf-8')))
        atomic(current, checkpoint)
        restored = json.loads(current.read_text(encoding='utf-8'))
        assert restored['model'] == weights and restored['optimizerVelocity'] == velocity
    if step % config['stdoutEverySteps'] == 0:
        print(json.dumps(metric, sort_keys=True), flush=True)
atomic(artifacts / 'completed.json', {**metric, 'checkpoint': str(artifacts / 'resume.json'),
                                     'completionReason': 'explicit_algorithmic_step_count'})
print('CPU_SOAK_COMPLETED ' + run_id, flush=True)
'''


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    if os.name == 'posix':
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def read_json(path, fallback=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return fallback


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def detached_options():
    if os.name == 'nt':
        return {'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
    return {'start_new_session': True}


def rss_kib(pid):
    try:
        for line in Path('/proc', str(pid), 'status').read_text().splitlines():
            if line.startswith('VmRSS:'):
                return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return None


def process_identity(pid):
    """Anchor service recovery to a boot and start time, never a reusable PID."""
    try:
        fields = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            return None
        return {'pid': pid, 'startTicks': fields[19],
            'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    except (OSError, IndexError):
        return None


class RecoveredService:
    """Handle to a previously detached observer service, pinned by Linux pidfd."""
    def __init__(self, identity):
        self.pid = identity['pid']
        self.identity = identity
        self.handle = os.pidfd_open(self.pid)
        if process_identity(self.pid) != identity:
            os.close(self.handle)
            raise ProcessLookupError('Recorded service identity is no longer alive')

    def poll(self):
        return None if process_identity(self.pid) == self.identity else 0

    def terminate(self):
        signal.pidfd_send_signal(self.handle, signal.SIGTERM)

    def kill(self):
        signal.pidfd_send_signal(self.handle, signal.SIGKILL)

    def wait(self, timeout):
        until = time.monotonic() + timeout
        while self.poll() is None:
            if time.monotonic() >= until:
                raise subprocess.TimeoutExpired('recovered observer service', timeout)
            time.sleep(0.05)
        return 0

    def close(self):
        os.close(self.handle)


class Monitor:
    def __init__(self, state):
        self.state = state
        self.plan = read_json(state / 'plan.json')
        self.repo = Path(self.plan['repository'])
        self.credentials = read_json(state / 'credentials.json')
        self.broker = None
        self.agent = None
        self.events = []
        if (state / 'events.jsonl').exists():
            for line in (state / 'events.jsonl').read_text(encoding='utf-8').splitlines():
                try:
                    self.events.append(json.loads(line))
                except ValueError:
                    pass  # A partial final event cannot override committed observations.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def event(self, event, **detail):
        item = {'event': event, 'timestamp': time.time(), **detail}
        with (self.state / 'events.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(item, sort_keys=True) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        self.events.append(item)

    def request(self, method, route, body=None):
        payload = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.plan['endpoint'] + route, data=payload, method=method,
            headers={'Authorization': 'Bearer ' + self.credentials['client'], 'Content-Type': 'application/json'})
        # Only connection/delivery has a timeout; the accepted training does not.
        with self.opener.open(request, timeout=5) as response:
            payload = response.read(6 * 1024 * 1024 + 1)
            if len(payload) > 6 * 1024 * 1024:
                raise ValueError('Oversized broker response')
            return json.loads(payload)

    def spawn(self, command, logfile, env=None, service=None):
        with (self.state / logfile).open('ab', buffering=0) as output:
            child = subprocess.Popen(command, cwd=self.repo, env=env, stdin=subprocess.DEVNULL,
                stdout=output, stderr=subprocess.STDOUT, **detached_options())
        if service:
            identity = process_identity(child.pid)
            if identity is None:
                raise RuntimeError('Observer service exited before its identity was recorded')
            services = read_json(self.state / 'service-processes.json', {})
            atomic_json(self.state / 'service-processes.json', {**services, service: identity})
        return child

    def recover_service(self, name):
        identity = read_json(self.state / 'service-processes.json', {}).get(name)
        if identity and process_identity(identity['pid']) == identity:
            try:
                child = RecoveredService(identity)
            except ProcessLookupError:
                return None
            self.event('observer_service_adopted', service=name, pid=child.pid)
            return child
        return None

    def start_broker(self):
        env = dict(os.environ)
        env.pop('PAIR_VPS_CLIENT_PRINCIPALS', None)
        env.update({'PAIR_VPS_CLIENT_TOKEN': self.credentials['client'],
            'PAIR_VPS_AGENT_TOKENS': json.dumps({'soak-cpu': self.credentials['agent']}),
            'PAIR_VPS_PORT': str(self.plan['port']), 'PAIR_VPS_BIND': '127.0.0.1',
            'PAIR_VPS_DATA': str(self.state / 'broker'), 'NO_PROXY': '127.0.0.1,localhost'})
        self.broker = self.spawn([self.plan['node'], str(self.state / 'implementation' / 'src' / 'vps' / 'cli.js')], 'broker.log', env, 'broker')
        self.event('broker_started', pid=self.broker.pid)

    def start_agent(self):
        env = dict(os.environ)
        env['NO_PROXY'] = '127.0.0.1,localhost'
        self.agent = self.spawn([self.plan['python'], str(self.state / 'implementation' / 'pair-notebook-agent.py'),
            '--url', self.plan['endpoint'], '--id', 'soak-cpu', '--name', 'Local CPU soak agent',
            '--state', str(self.state / 'agent'), '--workspace', str(self.state / 'owner-workspace'),
            '--data-manifest', str(self.state / 'data-manifest.json'),
            '--token-file', str(self.state / 'agent-token'), '--python', self.plan['python'],
            '--poll-seconds', '1'], 'agent.log', env, 'agent')
        self.event('polling_agent_started', pid=self.agent.pid)

    @staticmethod
    def stop_poller(child):
        try:
            if child and child.poll() is None:
                try:
                    child.terminate()
                except ProcessLookupError:
                    return
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        finally:
            if isinstance(child, RecoveredService):
                child.close()

    def verify_completion(self, snapshot):
        artifacts = self.state / 'agent' / 'jobs' / self.plan['runId'] / 'work' / 'artifacts' / self.plan['runId']
        completed = read_json(artifacts / 'completed.json', {})
        checkpoint = read_json(artifacts / 'resume.json', {})
        event_names = {item['event'] for item in self.events}
        required = {'broker_offline_started', 'broker_restarted_same_durable_state',
            'polling_agent_restarted_same_identity', 'broker_observation_disconnected', 'broker_observation_reconnected'}
        checks = {'uniqueTrainingLaunch': snapshot['uniqueTrainingLaunches'] == 1,
            'explicitStepCountCompleted': completed.get('step') == self.plan['config']['steps'],
            'minimumWorkloadElapsed': completed.get('elapsedSeconds', 0) >= snapshot['plannedMinimumWorkloadSeconds'],
            'finalCheckpointCommitted': checkpoint.get('step') == self.plan['config']['steps'],
            'checkpointDatasetMatches': checkpoint.get('datasetSha256') == self.plan['config']['datasetSha256'],
            'isolatedDatasetMatches': snapshot['dataset']['isolatedFileSha256'] == self.plan['config']['datasetSha256'],
            'scheduledFaultsObserved': required <= event_names,
            'frozenImplementationMatches': all((self.state / 'implementation' / name).is_file()
                and sha256(self.state / 'implementation' / name) == digest
                for name, digest in self.plan['implementation']['filesSha256'].items())}
        atomic_json(self.state / 'verification.json', {'runId': self.plan['runId'], 'verifiedAt': time.time(),
            'actualWorkloadElapsedSeconds': completed.get('elapsedSeconds'), 'checks': checks,
            'passed': all(checks.values()), 'externalVps': 'not_evaluated', 'physicalGpu': 'not_evaluated',
            'realVsCodeLifecycle': 'not_evaluated'})
        if not all(checks.values()):
            raise RuntimeError('Soak completion verification failed: ' + ', '.join(name for name, passed in checks.items() if not passed))

    def snapshot(self, status, job=None, error=None):
        run_id = self.plan['runId']
        workspace = self.state / 'agent' / 'jobs' / run_id / 'work'
        artifacts = workspace / 'artifacts' / run_id
        process = read_json(artifacts / 'process.json', {})
        progress = read_json(artifacts / 'progress.json')
        checkpoint = read_json(artifacts / 'resume.json')
        try:
            with (workspace / 'launches.jsonl').open(encoding='utf-8') as stream:
                launches = sum(1 for line in stream if json.loads(line)['runId'] == run_id)
        except OSError:
            launches = 0
        summary = None if job is None else {key: value for key, value in job.items() if key not in ('files', 'args', 'log')}
        value = {'formatVersion': 1, 'runId': run_id, 'state': status, 'observedAt': time.time(),
            'startedAt': process.get('startedAt'),
            'actualElapsedSeconds': time.time() - process['startedAt'] if process else 0,
            'plannedMinimumWorkloadSeconds': self.plan['config']['steps'] * self.plan['config']['minimumStepSeconds'],
            'computationWallClockLimit': None, 'uniqueTrainingLaunches': launches,
            'job': summary, 'progress': progress,
            'checkpoint': None if checkpoint is None else {'path': str(artifacts / 'resume.json'),
                'step': checkpoint['step'], 'sha256': sha256(artifacts / 'resume.json'),
                'format': checkpoint['format'], 'hasModelAndOptimizer': True},
            'pids': {'monitor': os.getpid(), 'broker': self.broker.pid if self.broker else None,
                'pollingAgent': self.agent.pid if self.agent else None, 'training': process.get('pid')},
            'rssKiB': {'monitor': rss_kib(os.getpid()), 'broker': rss_kib(self.broker.pid) if self.broker else None,
                'pollingAgent': rss_kib(self.agent.pid) if self.agent else None,
                'training': rss_kib(process['pid']) if process else None},
            'faultEvents': self.events,
            'implementation': {**{key: item for key, item in self.plan['implementation'].items() if key != 'filesSha256'},
                'filesManifestPath': str(self.state / 'plan.json'),
                'copiedFileCount': len(self.plan['implementation'].get('filesSha256', {}))},
            'testKind': self.plan.get('testKind', 'multi_hour_cpu_soak'),
            'verification': read_json(self.state / 'verification.json'),
            'validationBoundary': 'production broker/agent and real Linux CPU/process/filesystem; loopback only',
            'dataset': {'declared': self.plan['dataset'],
                'isolatedFileSha256': sha256(workspace / 'owner-synthetic-data.json') if (workspace / 'owner-synthetic-data.json').exists() else None},
            'error': error, 'metricsPath': str(artifacts / 'metrics.jsonl')}
        atomic_json(self.state / 'snapshot.json', value)
        with (self.state / 'observations.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps({key: value[key] for key in ('observedAt', 'state', 'actualElapsedSeconds',
                'uniqueTrainingLaunches', 'progress', 'rssKiB')}, sort_keys=True) + '\n')
        return value

    def run(self):
        # Prevent two observers from managing the same broker/agent deployment.
        if not sys.platform.startswith('linux') or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            raise RuntimeError('This soak monitor requires Linux process identity, pidfd and lock semantics')
        import fcntl
        with (self.state / 'monitor.lock').open('a') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            atomic_json(self.state / 'monitor-process.json', process_identity(os.getpid()))
            saved = read_json(self.state / 'snapshot.json', {})
            if saved.get('runId') == self.plan['runId'] and saved.get('state') in ('succeeded', 'failed', 'cancelled', 'interrupted'):
                return
            names = {item['event'] for item in self.events}
            broker_down = 'broker_offline_started' in names
            broker_restarted = 'broker_restarted_same_durable_state' in names
            agent_restarted = 'polling_agent_restarted_same_identity' in names
            observation_lost = 'broker_observation_disconnected' in names
            observation_returned = 'broker_observation_reconnected' in names
            self.broker = self.recover_service('broker')
            self.agent = self.recover_service('agent')
            if self.broker is None and (not broker_down or broker_restarted):
                self.start_broker()
            if self.agent is None:
                self.start_agent()
            submission = {'id': self.plan['runId'], 'agentId': 'soak-cpu', 'title': 'Synthetic infrastructure CPU soak',
                'device': 'cpu', 'entrypoint': 'soak-train.py', 'args': [],
                'projectId': self.plan['projectId'], 'sessionId': self.plan['sessionId'],
                'dataset': self.plan['dataset'],
                'files': {'soak-train.py': TRAINING, 'soak-config.json': json.dumps(self.plan['config'], sort_keys=True)}}
            accepted = 'job_accepted' in names
            start = time.monotonic()
            # This is a readiness/admission deadline, never a training deadline.
            while not accepted and time.monotonic() - start < 60:
                try:
                    if self.request('GET', '/v1/agents'):
                        self.request('POST', '/v1/jobs', submission)
                        accepted = True
                        self.event('job_accepted', runId=self.plan['runId'])
                        break
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(1)
            if not accepted:
                raise RuntimeError('Broker/agent admission not confirmed; accepted jobs are never automatically retried with another ID')
            faults = self.plan['faultSchedule']
            while True:
                current = read_json(self.state / 'agent' / 'jobs' / self.plan['runId'] / 'work' / 'artifacts' / self.plan['runId'] / 'process.json')
                elapsed = time.time() - current['startedAt'] if current else 0
                if elapsed >= faults['brokerOfflineAtSeconds'] and not broker_down:
                    self.stop_poller(self.broker)
                    broker_down = True
                    self.event('broker_offline_started')
                if elapsed >= faults['brokerOnlineAtSeconds'] and broker_down and not broker_restarted:
                    self.start_broker()
                    broker_restarted = True
                    self.event('broker_restarted_same_durable_state')
                if elapsed >= faults['pollingAgentRestartAtSeconds'] and not agent_restarted:
                    self.stop_poller(self.agent)
                    self.start_agent()
                    agent_restarted = True
                    self.event('polling_agent_restarted_same_identity')
                observing = not (faults['observerOfflineAtSeconds'] <= elapsed < faults['observerOnlineAtSeconds'])
                if not observing and not observation_lost:
                    observation_lost = True
                    self.event('broker_observation_disconnected')
                if observing and observation_lost and not observation_returned:
                    observation_returned = True
                    self.event('broker_observation_reconnected')
                try:
                    job = self.request('GET', '/v1/jobs/' + self.plan['runId']) if observing else None
                    status = job['status'] if job else 'observation_disconnected'
                    snapshot = self.snapshot(status, job)
                    if snapshot['uniqueTrainingLaunches'] > 1:
                        raise RuntimeError('More than one training launch detected')
                    if job and status in ('succeeded', 'failed', 'cancelled', 'interrupted'):
                        self.event('job_terminal', status=status)
                        if status == 'succeeded':
                            self.verify_completion(snapshot)
                        self.snapshot(status, job)
                        # Terminal compute is already acknowledged before service cleanup.
                        self.stop_poller(self.agent)
                        self.stop_poller(self.broker)
                        return
                except (OSError, urllib.error.URLError) as error:
                    self.snapshot('waiting_for_broker', error=type(error).__name__)
                time.sleep(self.plan.get('observationSeconds', 5))


def prepare(args):
    if not sys.platform.startswith('linux') or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('This soak runner requires Linux process identity, pidfd and lock semantics')
    if shutil.which('node') is None:
        raise RuntimeError('Node.js is required; compile the repository before starting this run')
    state = args.state.resolve()
    state.mkdir(parents=True, exist_ok=False, mode=0o700)
    workspace = state / 'owner-workspace'
    workspace.mkdir(mode=0o700)
    implementation = state / 'implementation'
    implementation.mkdir(mode=0o700)
    # Freeze the tested implementation: later compilation/editing cannot alter this run.
    shutil.copytree(args.repo.resolve() / 'out' / 'src', implementation / 'src')
    shutil.copy(args.repo.resolve() / 'scripts' / 'pair-notebook-agent.py', implementation)
    shutil.copy(Path(__file__).resolve(), implementation / 'persistent-soak.py')
    shutil.copytree(args.repo.resolve() / 'node_modules' / 'ws', implementation / 'node_modules' / 'ws')
    randomizer = random.Random(41)
    dataset = []
    for _ in range(256):
        features = [randomizer.gauss(0, 1) for _ in range(4)]
        dataset.append({'features': features, 'label': int(features[0] + 0.6 * features[1] > 2)})
    atomic_json(workspace / 'owner-synthetic-data.json', dataset)
    dataset_hash = sha256(workspace / 'owner-synthetic-data.json')
    data_manifest = {'version': 'soak-fixture-v1', 'files': [{'path': 'owner-synthetic-data.json',
        'size': (workspace / 'owner-synthetic-data.json').stat().st_size, 'sha256': dataset_hash}]}
    atomic_json(state / 'data-manifest.json', data_manifest)
    dataset_identity = {'version': data_manifest['version'], 'sha256': hashlib.sha256(
        json.dumps(data_manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')).hexdigest()}
    config = {'steps': args.steps, 'minimumStepSeconds': args.step_seconds,
        'checkpointEverySteps': args.checkpoint_steps, 'stdoutEverySteps': args.stdout_steps,
        'updatesPerStep': args.updates_per_step, 'seed': 41, 'datasetSha256': dataset_hash,
        'datasetDescription': 'Synthetic infrastructure fixture; not research anti-fraud results'}
    with socket.socket() as candidate:
        candidate.bind(('127.0.0.1', 0))
        port = candidate.getsockname()[1]
    credentials = {'client': secrets.token_hex(32), 'agent': secrets.token_hex(32)}
    atomic_json(state / 'credentials.json', credentials)
    (state / 'credentials.json').chmod(0o600)
    (state / 'agent-token').write_text(credentials['agent'], encoding='utf-8')
    (state / 'agent-token').chmod(0o600)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.repo, text=True).strip()
    implementation_hashes = {str(path.relative_to(implementation)): sha256(path)
        for path in sorted(implementation.rglob('*')) if path.is_file()}
    plan = {'runId': 'soak-' + secrets.token_hex(8), 'projectId': 'synthetic-soak-project',
        'sessionId': 'synthetic-soak-session', 'repository': str(args.repo.resolve()),
        'createdAt': time.time(), 'port': port, 'endpoint': 'http://127.0.0.1:' + str(port),
        'node': shutil.which('node'), 'python': sys.executable, 'config': config, 'dataset': dataset_identity,
        'observationSeconds': args.observation_seconds,
        'testKind': 'multi_hour_cpu_soak' if args.steps * args.step_seconds >= 14400 and args.fault_scale == 1 else 'short_cpu_regression',
        'faultSchedule': {key: value * args.fault_scale for key, value in
            {'brokerOfflineAtSeconds': 30, 'brokerOnlineAtSeconds': 50,
             'pollingAgentRestartAtSeconds': 65, 'observerOfflineAtSeconds': 85, 'observerOnlineAtSeconds': 115}.items()},
        'implementation': {'gitHeadBeforeRun': commit, 'agentSha256': sha256(implementation / 'pair-notebook-agent.py'),
            'brokerSha256': sha256(implementation / 'src' / 'vps' / 'server.js'),
            'protocolSha256': sha256(implementation / 'src' / 'vps' / 'protocol.js'),
            'workloadSha256': hashlib.sha256(TRAINING.encode()).hexdigest(),
            'filesSha256': implementation_hashes,
            'filesManifestSha256': hashlib.sha256(json.dumps(implementation_hashes, sort_keys=True).encode()).hexdigest(),
            'workingTreeModifiedBeforeRun': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=args.repo, text=True)),
            'platform': platform.platform(), 'pythonVersion': platform.python_version(),
            'nodeVersion': subprocess.check_output(['node', '--version'], text=True).strip()}}
    atomic_json(state / 'plan.json', plan)
    child = start_monitor(state)
    print(json.dumps({'stateDirectory': str(state), 'monitorPid': child.pid, 'runId': plan['runId'],
        'testKind': plan['testKind'],
        'plannedMinimumWorkloadSeconds': config['steps'] * config['minimumStepSeconds'],
        'statusCommand': shlex.join([sys.executable, str(state / 'implementation' / 'persistent-soak.py'), 'status', '--state', str(state)]),
        'resumeObserverCommand': shlex.join([sys.executable, str(state / 'implementation' / 'persistent-soak.py'), 'observe', '--state', str(state)])}, indent=2))


def start_monitor(state):
    with (state / 'monitor.log').open('ab', buffering=0) as output:
        child = subprocess.Popen([sys.executable, str(state / 'implementation' / 'persistent-soak.py'), 'monitor', '--state', str(state)],
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, **detached_options())
    return child


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'monitor', 'observe', 'status', 'cancel'])
    parser.add_argument('--state', type=Path, required=True, help='Persistent run directory; start requires a new path')
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--steps', type=int, default=14400, help='Explicit algorithmic step count (default 14400)')
    parser.add_argument('--step-seconds', type=float, default=1.0, help='Explicit minimum cadence; never an execution deadline')
    parser.add_argument('--checkpoint-steps', type=int, default=60)
    parser.add_argument('--stdout-steps', type=int, default=300, help='Default silence between output events is five minutes')
    parser.add_argument('--updates-per-step', type=int, default=20)
    parser.add_argument('--observation-seconds', type=float, default=5)
    parser.add_argument('--fault-scale', type=float, default=1, help='Use values below 1 only for explicitly short regression runs')
    args = parser.parse_args()
    if args.action == 'start':
        if min(args.steps, args.checkpoint_steps, args.stdout_steps, args.updates_per_step) <= 0 or not math.isfinite(args.step_seconds) or args.step_seconds < 0:
            parser.error('Step counts must be positive and step cadence finite/nonnegative')
        if any(not math.isfinite(value) or value <= 0 for value in (args.observation_seconds, args.fault_scale)):
            parser.error('Observation cadence and fault scale must be finite and positive')
        prepare(args)
    elif args.action == 'observe':
        identity = read_json(args.state / 'monitor-process.json')
        saved = read_json(args.state / 'snapshot.json', {})
        if saved.get('state') in ('succeeded', 'failed', 'cancelled', 'interrupted'):
            print(json.dumps({'state': saved['state'], 'message': 'The run is terminal; no observer was started.'}))
        elif identity and process_identity(identity['pid']) == identity:
            print(json.dumps({'state': 'already_observing', 'monitorPid': identity['pid']}))
        else:
            child = start_monitor(args.state.resolve())
            print(json.dumps({'state': 'observer_started', 'monitorPid': child.pid}))
    elif args.action == 'status':
        snapshot = read_json(args.state / 'snapshot.json')
        if snapshot:
            age = max(0.0, time.time() - snapshot['observedAt'])
            snapshot = {**snapshot, 'observationAgeSeconds': age,
                'observerStale': age > 20 and snapshot['state'] not in ('succeeded', 'failed', 'cancelled', 'interrupted')}
        else:
            snapshot = {'state': 'awaiting_first_observation' if (args.state / 'plan.json').exists() else 'not_started',
                'stateDirectory': str(args.state)}
        print(json.dumps(snapshot, indent=2))
    elif args.action == 'cancel':
        monitor = Monitor(args.state.resolve())
        saved = read_json(args.state / 'snapshot.json', {})
        if saved.get('runId') == monitor.plan['runId'] and saved.get('state') in ('succeeded', 'failed', 'cancelled', 'interrupted'):
            print(json.dumps({'state': saved['state'], 'message': 'The run is already terminal; no cancellation was sent.'}))
            return
        job = monitor.request('GET', '/v1/jobs/' + monitor.plan['runId'])
        if job['status'] in ('succeeded', 'failed', 'cancelled', 'interrupted'):
            print(json.dumps({'state': job['status'], 'message': 'The run is already terminal; no cancellation was sent.'}))
            return
        scope = {'projectId': monitor.plan['projectId'], 'sessionId': monitor.plan['sessionId']}
        challenge = monitor.request('POST', '/v1/confirmations',
            {'action': 'cancel_job', 'scope': scope, 'targetIds': [monitor.plan['runId']]})
        snapshot = read_json(args.state / 'snapshot.json', {})
        print(json.dumps({'runId': job['id'], 'title': job['title'], 'executor': job['agentId'],
            'scope': scope, 'elapsedSeconds': snapshot.get('actualElapsedSeconds'),
            'lastCheckpoint': snapshot.get('checkpoint'),
            'processScope': 'This run training process and its supervised descendants',
            'warning': 'State after the last completed checkpoint may be lost.'}, indent=2))
        try:
            text = input('Type exactly CONFIRM to stop this run: ')
        except (EOFError, KeyboardInterrupt):
            print('\nCancellation abandoned.')
            return
        if text != 'CONFIRM':
            print('Cancellation abandoned: exact confirmation was not entered.')
            return
        result = monitor.request('POST', '/v1/confirmations/' + challenge['id'] + '/apply', {'text': text})
        print(json.dumps(result, indent=2))
    else:
        monitor = Monitor(args.state.resolve())
        try:
            monitor.run()
        except BlockingIOError:
            # A second observer never corrupts the active observer's snapshot.
            raise RuntimeError('Another observer already owns this state directory') from None
        except Exception as error:
            # Observer failure preserves accepted compute; no implicit cancellation.
            monitor.event('monitor_failed', errorType=type(error).__name__)
            monitor.snapshot('monitor_failed', error=type(error).__name__)
            raise


if __name__ == '__main__':
    main()
