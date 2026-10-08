"""Real subprocess and agent recovery checks; no CUDA hardware is claimed here."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("pair_agent", Path(__file__).resolve().parents[1] / "scripts" / "pair-notebook-agent.py")
agent_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent_module)
GPU_UUID = "GPU-01234567-89ab-cdef-0123-456789abcdef"


class Stage32(unittest.TestCase):
    pass


def execution_case(mask):
    def test(self):
        with tempfile.TemporaryDirectory(prefix="pair-agent-audit-") as temporary:
            root = Path(temporary)
            args = ["literal; touch unexpected", "a b"] if mask & 4 else []
            text = "обучение ✓" if mask & 2 else "training"
            source = ("import json, os, sys\nfrom helper import TEXT\n"
                      "print(json.dumps({'text': TEXT, 'args': sys.argv[1:], 'gpu': os.environ.get('CUDA_VISIBLE_DEVICES'), "
                      "'secret': os.environ.get('PAIR_AGENT_TOKEN'), 'stdin': sys.stdin.read()}), flush=True)\n"
                      + ("sys.exit(3)\n" if mask & 8 else ""))
            job = {"id": f"matrix-{mask}", "agentId": "pc", "device": "gpu:7" if mask & 1 else "cpu",
                   "entrypoint": "train.py", "args": args, "files": {"train.py": source, "helper.py": "TEXT = " + repr(text)}}
            agent_module.atomic_json(root / "manifest.json", {"job": job, "python": sys.executable,
                                     "workspace": temporary, "cudaDevice": GPU_UUID if mask & 1 else ""})
            if mask & 16:
                (root / "cancel").touch()
            with patch.dict(os.environ, {"PAIR_AGENT_TOKEN": "owner-secret"}):
                agent_module.run_job(root)
            result = agent_module.read_json(root / "result.json")
            if mask & 16:
                self.assertEqual(result["status"], "cancelled")
                self.assertEqual((root / "output.log").read_bytes(), b"")
                return
            self.assertEqual(result, {"status": "failed" if mask & 8 else "succeeded", "exitCode": 3 if mask & 8 else 0})
            output = json.loads((root / "output.log").read_text())
            self.assertEqual(output, {"text": text, "args": args, "gpu": GPU_UUID if mask & 1 else "", "secret": None, "stdin": ""})
            self.assertFalse((root / "work" / "unexpected").exists())
    return test


for case in range(32):
    setattr(Stage32, f"test_case_{case:02d}", execution_case(case))


class AgentRegressions(unittest.TestCase):
    def args(self, root, python=sys.executable):
        return argparse.Namespace(url="http://localhost:9999", id="pc", name="PC", token_file=None,
                                  state=str(root / "state"), workspace=str(root), python=python)

    def test_relative_interpreter_preserves_venv_symlink_after_changing_job_directory(self):
        if os.name == "nt":
            self.skipTest("Symlink creation depends on Windows developer mode")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            selected = root / "env" / "bin" / "python"
            selected.parent.mkdir(parents=True)
            selected.symlink_to(sys.executable)
            previous = os.getcwd()
            try:
                os.chdir(root)
                with patch.dict(os.environ, {"PAIR_AGENT_TOKEN": "a" * 32}), patch.object(agent_module.subprocess, "run", side_effect=OSError):
                    agent = agent_module.Agent(self.args(root, "./env/bin/python"))
                self.assertEqual(agent.args.python, str(selected))
                self.assertTrue(Path(agent.args.python).is_symlink())
                agent.lock.close()
            finally:
                os.chdir(previous)

    def test_gpu_inventory_uses_uuid_and_csv_fields(self):
        fake = Mock(stdout=f'7, {GPU_UUID}, "GPU, training", 8192\n')
        agent = agent_module.Agent.__new__(agent_module.Agent)
        agent.args = argparse.Namespace(python=sys.executable)
        with patch.object(agent_module.subprocess, "run", return_value=fake) as query:
            resources = agent.inventory()
        self.assertEqual(resources["gpus"], [{"index": 7, "uuid": GPU_UUID, "name": "GPU, training", "memoryMb": 8192.0}])
        self.assertIn("--query-gpu=index,uuid,name,memory.total", query.call_args.args[0])

    def test_recovery_uses_monotonic_grace_and_never_respawns_an_ambiguous_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.dict(os.environ, {"PAIR_AGENT_TOKEN": "a" * 32}), patch.object(agent_module.subprocess, "run", side_effect=OSError):
                agent = agent_module.Agent(self.args(root))
            directory = agent.state / "jobs" / "ambiguous"
            directory.mkdir(parents=True)
            job = {"id": "ambiguous"}
            agent_module.atomic_json(directory / "manifest.json", {"job": job, "launchedAt": 10**15})
            agent.recovery_started["ambiguous"] = 10
            with patch.object(agent_module.time, "monotonic", return_value=21), patch.object(agent_module.subprocess, "Popen") as spawn:
                agent.ensure_job(job)
                agent.ensure_job(job)
            spawn.assert_not_called()
            self.assertEqual(agent_module.read_json(directory / "result.json")["status"], "interrupted")
            agent.lock.close()

    def test_output_read_failure_terminates_training_and_records_a_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            agent_module.atomic_json(root / "manifest.json", {"job": {"id": "broken-log", "device": "cpu", "entrypoint": "train.py",
                                     "files": {"train.py": "print('hello')"}, "args": []}, "python": sys.executable, "workspace": temporary})
            process = Mock(pid=12345)
            process.poll.return_value = None
            process.stdout.read1.side_effect = OSError("Failed output stream")
            process.wait.return_value = 1
            def terminate(_process):
                process.poll.return_value = 1
            with patch.object(agent_module.subprocess, "Popen", return_value=process), \
                 patch.object(agent_module, "stop_process", side_effect=terminate) as stop, patch.object(agent_module.os, "killpg", create=True):
                agent_module.run_job(root)
            self.assertGreaterEqual(stop.call_count, 1)
            self.assertEqual(agent_module.read_json(root / "result.json")["status"], "failed")

    def test_large_output_is_drained_after_the_local_retention_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            agent_module.atomic_json(root / "manifest.json", {"job": {"id": "verbose", "device": "cpu", "entrypoint": "train.py",
                                     "files": {"train.py": "import sys\nsys.stdout.buffer.write(b'x' * (34 * 1024 * 1024))"}, "args": []},
                                     "python": sys.executable, "workspace": temporary})
            agent_module.run_job(root)
            self.assertEqual(agent_module.read_json(root / "result.json")["status"], "succeeded")
            self.assertLess((root / "output.log").stat().st_size, agent_module.MAX_LOG + 1024)
            with (root / "output.log").open("rb") as output:
                output.seek(-100, os.SEEK_END)
                self.assertIn(b"local output limit reached", output.read())

    def test_cli_rejects_nonfinite_poll_intervals_before_starting(self):
        for interval in ("nan", "inf", "-inf"):
            result = subprocess.run([sys.executable, agent_module.__file__, "--url", "http://localhost:9999", "--id", "pc",
                                     "--poll-seconds=" + interval], capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 2)

    def test_queue_gpu_identity_survives_inventory_index_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inventory = {"cpuCount": 4, "python": sys.executable, "gpus": [{"index": 2, "uuid": GPU_UUID, "name": "GPU", "memoryMb": 8192}]}
            with patch.dict(os.environ, {"PAIR_AGENT_TOKEN": "a" * 32}), patch.object(agent_module.Agent, "inventory", return_value=inventory):
                agent = agent_module.Agent(self.args(root))
                job = {"id": "gpu-reordered", "device": "gpu:7", "gpuUuid": GPU_UUID, "entrypoint": "train.py", "files": {"train.py": ""}, "args": []}
                with patch.object(agent_module.subprocess, "Popen"):
                    directory = agent.ensure_job(job)
                self.assertEqual(agent_module.read_json(directory / "manifest.json")["cudaDevice"], GPU_UUID)
                agent.lock.close()


if __name__ == "__main__":
    unittest.main()
