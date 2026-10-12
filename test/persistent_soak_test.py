"""Focused stdlib regressions for the detached soak observer and its evidence."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


REPO = Path(__file__).resolve().parents[1]
SOAK_SCRIPT = Path(os.environ.get('PAIR_SOAK_SCRIPT', REPO / 'scripts/persistent-soak.py'))
SPEC = importlib.util.spec_from_file_location('persistent_soak', SOAK_SCRIPT)
SOAK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOAK)
LINUX_PIDFD = sys.platform.startswith('linux') and hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal')


@unittest.skipUnless(LINUX_PIDFD, 'Detached soak ownership requires Linux pidfd semantics')
class PersistentSoakTest(unittest.TestCase):
    def test_recovered_observer_service_has_kernel_pinned_ownership(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], start_new_session=True)
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], start_new_session=True)
        try:
            identity = SOAK.process_identity(child.pid)
            self.assertIsNotNone(identity)
            with self.assertRaises(ProcessLookupError):
                SOAK.RecoveredService({**identity, 'startTicks': 'invalid-start-time'})
            self.assertIsNone(child.poll())
            recovered = SOAK.RecoveredService(identity)
            self.assertIsNone(recovered.poll())
            SOAK.Monitor.stop_poller(recovered)
            child.wait(timeout=5)
            self.assertIsNone(unrelated.poll(), 'Stopping an adopted observer must leave unrelated processes alive')
        finally:
            for process in (child, unrelated):
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)

    def test_second_monitor_cannot_overwrite_active_observer_snapshot(self):
        import fcntl
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            SOAK.atomic_json(state / 'plan.json', {'repository': str(REPO), 'runId': 'lock-test',
                'config': {'steps': 1, 'minimumStepSeconds': 1}, 'implementation': {}, 'dataset': {}})
            SOAK.atomic_json(state / 'credentials.json', {'client': 'test', 'agent': 'test'})
            SOAK.atomic_json(state / 'snapshot.json', {'state': 'running', 'runId': 'lock-test', 'observedAt': 1})
            original = (state / 'snapshot.json').read_bytes()
            with (state / 'monitor.lock').open('a') as held:
                fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                contender = subprocess.run([sys.executable, str(SOAK_SCRIPT),
                    'monitor', '--state', str(state)], capture_output=True, text=True, timeout=10)
            self.assertNotEqual(contender.returncode, 0)
            self.assertEqual((state / 'snapshot.json').read_bytes(), original)
            self.assertIn('Another observer already owns this state directory', contender.stderr)
            self.assertFalse((state / 'service-processes.json').exists())

    def test_cancel_dialog_only_applies_an_exact_fresh_confirmation(self):
        for text in ('', 'confirm', 'Confirm', ' CONFIRM', 'CONFIRM ', 'CONFIRM! ', 'CONFIRM'):
            with self.subTest(text=text), tempfile.TemporaryDirectory() as directory:
                monitor = Mock()
                monitor.plan = {'runId': 'cancel-test', 'projectId': 'project', 'sessionId': 'session'}
                monitor.request.side_effect = [{'id': 'cancel-test', 'status': 'running',
                    'title': 'Test', 'agentId': 'test-cpu'}, {'id': 'fresh-challenge'}, {'state': 'stopping'}]
                with patch.object(SOAK, 'Monitor', return_value=monitor), \
                        patch.object(sys, 'argv', [str(SOAK_SCRIPT), 'cancel', '--state', directory]), \
                        patch('builtins.input', return_value=text), contextlib.redirect_stdout(io.StringIO()):
                    SOAK.main()
                self.assertEqual(monitor.request.call_count, 3 if text == 'CONFIRM' else 2)
                self.assertEqual(monitor.request.call_args_list[1].args,
                    ('POST', '/v1/confirmations', {'action': 'cancel_job',
                     'scope': {'projectId': 'project', 'sessionId': 'session'}, 'targetIds': ['cancel-test']}))
                if text == 'CONFIRM':
                    self.assertEqual(monitor.request.call_args.args,
                        ('POST', '/v1/confirmations/fresh-challenge/apply', {'text': 'CONFIRM'}))

    def test_cancel_dialog_abandonment_preserves_compute(self):
        for interruption in (EOFError, KeyboardInterrupt):
            with self.subTest(interruption=interruption), tempfile.TemporaryDirectory() as directory:
                monitor = Mock()
                monitor.plan = {'runId': 'cancel-test', 'projectId': 'project', 'sessionId': 'session'}
                monitor.request.side_effect = [{'id': 'cancel-test', 'status': 'running',
                    'title': 'Test', 'agentId': 'test-cpu'}, {'id': 'fresh-challenge'}]
                with patch.object(SOAK, 'Monitor', return_value=monitor), \
                        patch.object(sys, 'argv', [str(SOAK_SCRIPT), 'cancel', '--state', directory]), \
                        patch('builtins.input', side_effect=interruption), contextlib.redirect_stdout(io.StringIO()):
                    SOAK.main()
                self.assertEqual(monitor.request.call_count, 2)

    def test_preparation_freezes_monitor_agent_dependencies_and_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, state = root / 'repo', root / 'state'
            files = {'out/src/vps/cli.js': 'cli', 'out/src/vps/server.js': 'server',
                'out/src/vps/protocol.js': 'protocol', 'out/src/core/atomicFile.js': 'atomic',
                'scripts/pair-notebook-agent.py': 'agent', 'node_modules/ws/package.json': '{}'}
            for name, content in files.items():
                target = repo / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            args = SimpleNamespace(state=state, repo=repo, steps=14400, step_seconds=1,
                checkpoint_steps=60, stdout_steps=300, updates_per_step=20, observation_seconds=5, fault_scale=1)

            def metadata(command, **_kwargs):
                return 'node-test\n' if command[0] == 'node' else ('modified\n' if 'status' in command else 'commit-test\n')

            with patch.object(SOAK.subprocess, 'Popen', return_value=SimpleNamespace(pid=12345)) as launch, \
                    patch.object(SOAK.subprocess, 'check_output', side_effect=metadata), \
                    patch.object(SOAK.shutil, 'which', return_value='/test/node'), \
                    patch.object(SOAK.socket, 'socket') as reservation, contextlib.redirect_stdout(io.StringIO()):
                reservation.return_value.__enter__.return_value.getsockname.return_value = ('127.0.0.1', 12345)
                SOAK.prepare(args)
            self.assertEqual(launch.call_args.args[0][1], str(state / 'implementation/persistent-soak.py'))
            self.assertTrue(launch.call_args.kwargs['start_new_session'])
            self.assertEqual(launch.call_args.kwargs['stdin'], subprocess.DEVNULL)
            plan = SOAK.read_json(state / 'plan.json')
            self.assertEqual(plan['testKind'], 'multi_hour_cpu_soak')
            self.assertTrue(plan['implementation']['workingTreeModifiedBeforeRun'])
            expected = plan['implementation']['filesSha256']
            self.assertIn('persistent-soak.py', expected)
            self.assertIn('src/core/atomicFile.js', expected)
            self.assertIn('node_modules/ws/package.json', expected)
            (repo / 'scripts/pair-notebook-agent.py').write_text('later edited agent')
            self.assertEqual((state / 'implementation/pair-notebook-agent.py').read_text(), 'agent')
            self.assertTrue(all(SOAK.sha256(state / 'implementation' / name) == digest for name, digest in expected.items()))
            self.assertEqual((state / 'credentials.json').stat().st_mode & 0o777, 0o600)

    def test_workload_and_completion_evidence_reject_false_success(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            run_id = 'evidence-test'
            work = state / 'agent/jobs' / run_id / 'work'
            work.mkdir(parents=True)
            rows = [{'features': [1, 0, 0, 0], 'label': 1}, {'features': [-1, 0, 0, 0], 'label': 0}]
            SOAK.atomic_json(work / 'owner-synthetic-data.json', rows)
            config = {'steps': 2, 'minimumStepSeconds': 0.025, 'updatesPerStep': 2,
                'checkpointEverySteps': 1, 'stdoutEverySteps': 300, 'seed': 41,
                'datasetSha256': SOAK.sha256(work / 'owner-synthetic-data.json')}
            SOAK.atomic_json(work / 'soak-config.json', config)
            run = subprocess.run([sys.executable, '-c', SOAK.TRAINING], cwd=work,
                env={**os.environ, 'PAIR_NOTEBOOK_WORKSPACE': str(work), 'PAIR_NOTEBOOK_JOB_ID': run_id},
                capture_output=True, text=True, timeout=10)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn('CPU_SOAK_COMPLETED', run.stdout)
            artifacts = work / 'artifacts' / run_id
            checkpoint = SOAK.read_json(artifacts / 'resume.json')
            self.assertEqual(checkpoint['step'], 2)
            self.assertEqual(len(checkpoint['model']), 5)
            self.assertEqual(len(checkpoint['optimizerVelocity']), 5)
            self.assertEqual(checkpoint['configSha256'], SOAK.sha256(work / 'soak-config.json'))
            self.assertEqual(SOAK.read_json(artifacts / 'resume.previous.json')['step'], 1)
            implementation = state / 'implementation'
            implementation.mkdir()
            (implementation / 'test-source').write_text('frozen implementation')
            SOAK.atomic_json(state / 'plan.json', {'runId': run_id, 'repository': str(REPO),
                'config': config, 'dataset': {'version': 'fixture'},
                'implementation': {'filesSha256': {'test-source': SOAK.sha256(implementation / 'test-source')}}})
            SOAK.atomic_json(state / 'credentials.json', {'client': 'test', 'agent': 'test'})
            monitor = SOAK.Monitor(state)
            monitor.events = [{'event': name} for name in ['broker_offline_started', 'broker_restarted_same_durable_state',
                'polling_agent_restarted_same_identity', 'broker_observation_disconnected', 'broker_observation_reconnected']]
            snapshot = monitor.snapshot('succeeded', {'status': 'succeeded'})
            monitor.verify_completion(snapshot)
            self.assertTrue(SOAK.read_json(state / 'verification.json')['passed'])
            self.assertEqual(snapshot['uniqueTrainingLaunches'], 1)
            (implementation / 'test-source').write_text('modified implementation')
            with self.assertRaisesRegex(RuntimeError, 'frozenImplementationMatches'):
                monitor.verify_completion(snapshot)
            self.assertFalse(SOAK.read_json(state / 'verification.json')['passed'])
            snapshot['uniqueTrainingLaunches'] = 2
            with self.assertRaisesRegex(RuntimeError, 'uniqueTrainingLaunch'):
                monitor.verify_completion(snapshot)


if __name__ == '__main__':
    unittest.main()
