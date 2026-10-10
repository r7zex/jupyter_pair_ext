"""Real local compiled broker/agent/CPU reference integration.

Run after npm run compile with PAIR_REFERENCE_PYTHON pointing to an isolated
interpreter containing examples/anti_fraud_reference/requirements.txt.
PAIR_REFERENCE_EVIDENCE optionally retains all logs and artifacts in a parent
directory. This test does not establish an external VPS or physical GPU result.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

REPO = Path(__file__).resolve().parents[1]
SOURCE_FILES = ["__init__.py", "__main__.py", "checkpoints.py", "data.py", "metrics.py",
                "pipeline.py", "report.py", "run_reference.py", "requirements.txt"]

# Only instrumentation pauses after the first committed epoch; training and
# inference both run through the actual exported reference command-line entry.
ENTRYPOINT = r'''
import builtins
import json
import os
from pathlib import Path
import runpy
import sys
import time
import torch

torch.set_num_threads(1)
work = Path(os.environ["PAIR_NOTEBOOK_WORKSPACE"])
with (work / "launch-count.txt").open("a") as stream:
    stream.write("started\n")
(work / "execution.json").write_text(json.dumps({"pid": os.getpid(), "python": sys.executable,
    "workspace": str(work), "jobId": os.environ["PAIR_NOTEBOOK_JOB_ID"],
    "sourceSha256": os.environ["PAIR_NOTEBOOK_SOURCE_SHA256"],
    "datasetSha256": os.environ["PAIR_NOTEBOOK_DATA_SHA256"]}))
original_print = builtins.print
paused = False
def epoch_boundary(*args, **kwargs):
    global paused
    original_print(*args, **kwargs)
    if paused or not args or not isinstance(args[0], str):
        return
    try:
        payload = json.loads(args[0])
    except (ValueError, TypeError):
        return
    if payload.get("epoch") != 1 or "last_checkpoint" not in payload:
        return
    paused = True
    (work / "epoch-one.json").write_text(json.dumps(payload))
    deadline = time.monotonic() + 45
    while not (work / "continue-training").exists():
        if time.monotonic() > deadline:
            raise RuntimeError("Integration coordinator did not release the committed epoch gate")
        time.sleep(.05)
builtins.print = epoch_boundary
entry = work / "examples/anti_fraud_reference/run_reference.py"
sys.argv = [str(entry), "train", "--config", str(work / "config.json"),
            "--data", str(work / "transactions.csv"), "--manifest", str(work / "dataset-manifest.json"),
            "--output", str(work / "artifacts")]
runpy.run_path(str(entry), run_name="__main__")
builtins.print = original_print
sys.argv = [str(entry), "evaluate-export", "--checkpoints", str(work / "artifacts/checkpoints"),
            "--data", str(work / "transactions.csv"), "--manifest", str(work / "dataset-manifest.json"),
            "--output", str(work / "artifacts/export-evaluation.json")]
runpy.run_path(str(entry), run_name="__main__")
from examples.anti_fraud_reference.checkpoints import CheckpointStore
saved, _, _ = CheckpointStore(work / "artifacts/checkpoints").load("resume")
(work / "checkpoint-evidence.json").write_text(json.dumps({"epoch": saved["epoch"],
    "global_step": saved["global_step"], "run_id": saved["run_id"],
    "state_keys": sorted(saved), "history_length": len(saved["history"])}))
'''


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@unittest.skipIf(sys.platform == "win32", "This fault-injection test uses POSIX watcher SIGKILL")
class PersistentReferenceIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.python = os.environ.get("PAIR_REFERENCE_PYTHON")
        if not self.python or not Path(self.python).is_file():
            self.skipTest("Set PAIR_REFERENCE_PYTHON to the isolated Torch reference interpreter")
        if not (REPO / "out/src/vps/cli.js").is_file():
            self.skipTest("Compile the local broker with npm run compile before this integration test")
        prepared = subprocess.run([self.python, "-c", "import torch, numpy"], capture_output=True, text=True, timeout=30)
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        retained = os.environ.get("PAIR_REFERENCE_EVIDENCE")
        if retained:
            Path(retained).mkdir(parents=True, exist_ok=True)
            self.root = Path(tempfile.mkdtemp(prefix="reference-", dir=retained))
            self.temporary = None
        else:
            self.temporary = tempfile.TemporaryDirectory(prefix="pair-reference-broker-")
            self.root = Path(self.temporary.name)
        self.broker = None
        self.watcher = None
        self.handles = []
        self.team = secrets.token_hex(32)
        self.agent_token = secrets.token_hex(32)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        self.endpoint = f"http://127.0.0.1:{self.port}"
        self.owner = self.root / "owner-data"
        self.state = self.root / "agent-state"
        self.job_id = "real-reference-two-epochs"
        self.job_directory = self.state / "jobs" / self.job_id
        self.work = self.job_directory / "work"
        self.frozen = self.root / "compiled-broker"
        # Freeze only the four relevant compiled modules; restart must exercise
        # the same broker bytes even when another test rebuilds the checkout.
        for relative in ["vps/cli.js", "vps/server.js", "vps/protocol.js", "core/atomicFile.js"]:
            destination = self.frozen / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / "out/src" / relative, destination)
        self.agent_script = self.root / "pair-notebook-agent.py"
        shutil.copyfile(REPO / "scripts/pair-notebook-agent.py", self.agent_script)

    def tearDown(self):
        if hasattr(self, "work") and self.work.is_dir():
            (self.work / "continue-training").touch()
        for child in [getattr(self, "watcher", None), getattr(self, "broker", None)]:
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        for handle in getattr(self, "handles", []):
            handle.close()
        if getattr(self, "temporary", None):
            self.temporary.cleanup()

    def wait_for(self, condition, description, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if condition():
                    return
            except (OSError, ValueError, urllib.error.URLError):
                pass
            time.sleep(.05)
        logs = []
        for name in ["broker.log", "agent.log"]:
            source = self.root / name
            if source.exists():
                logs.append(f"{name}: {source.read_text()[-3000:]}")
        if (self.job_directory / "output.log").exists():
            logs.append((self.job_directory / "output.log").read_text()[-4000:])
        self.fail(f"Timed out waiting for {description}\n" + "\n".join(logs))

    def request(self, route, body=None):
        request = urllib.request.Request(self.endpoint + route,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.team}", "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def launch_broker(self):
        log = (self.root / "broker.log").open("ab")
        self.handles.append(log)
        env = {**os.environ, "PAIR_VPS_PORT": str(self.port), "PAIR_VPS_BIND": "127.0.0.1",
               "PAIR_VPS_DATA": str(self.root / "broker-state"), "PAIR_VPS_CLIENT_TOKEN": self.team,
               "PAIR_VPS_AGENT_TOKENS": json.dumps({"reference-pc": self.agent_token}),
               "NODE_PATH": str(REPO / "node_modules")}
        # A parent task's optional grants must not accidentally control this
        # independent synthetic fixture's broker.
        env.pop("PAIR_VPS_CLIENT_PRINCIPALS", None)
        self.broker = subprocess.Popen(["node", str(self.frozen / "vps/cli.js")], cwd=REPO, env=env, stdout=log, stderr=log)
        self.wait_for(lambda: self.request("/v1/jobs") == [], "fresh compiled broker readiness")

    def launch_watcher(self):
        log = (self.root / "agent.log").open("ab")
        self.handles.append(log)
        self.watcher = subprocess.Popen([sys.executable, str(self.agent_script), "--url", self.endpoint,
            "--id", "reference-pc", "--name", "Reference CPU owner", "--state", str(self.state),
            "--workspace", str(self.owner), "--data-manifest", str(self.owner / "owner-data-manifest.json"),
            "--python", self.python, "--poll-seconds", "0.1"], cwd=REPO,
            env={**os.environ, "PAIR_AGENT_TOKEN": self.agent_token, "NO_PROXY": "127.0.0.1,localhost"}, stdout=log, stderr=log)

    def test_reference_pipeline_survives_broker_and_watcher_outage_without_duplicate_run(self):
        subprocess.run([self.python, "-m", "examples.anti_fraud_reference", "generate-data",
            "--output", str(self.owner), "--rows", "1600", "--seed", "91", "--label-delay", "16"],
            cwd=REPO, check=True, capture_output=True, text=True, timeout=30)
        data_manifest = json.loads((self.owner / "dataset-manifest.json").read_text())
        config = json.loads((REPO / "examples/anti_fraud_reference/configs/reference.json").read_text())
        config.update(epochs=2, batch_size=96, device="cpu", model="logistic", experiment_name="real-broker-reference-two-epochs")
        config["split"] = {"train_end": 850, "validation_start": 900, "validation_end": 1200,
                           "test_start": 1250, "test_end": 1600, "gap": 50}
        files = {f"examples/anti_fraud_reference/{name}":
                 (REPO / "examples/anti_fraud_reference" / name).read_text() for name in SOURCE_FILES}
        files.update({"config.json": json.dumps(config), "integration_entry.py": ENTRYPOINT})
        self.launch_broker()
        self.launch_watcher()
        self.wait_for(lambda: len(self.request("/v1/agents")) == 1, "owner compute inventory")
        resources = self.request("/v1/agents")[0]["resources"]
        identity = {key: resources["dataset"][key] for key in ["version", "sha256"]}
        self.assertEqual(identity["version"], data_manifest["dataset_id"])
        job = {"id": self.job_id, "agentId": "reference-pc", "projectId": "reference-project",
               "sessionId": "reference-session", "title": config["experiment_name"], "device": "cpu",
               "entrypoint": "integration_entry.py", "files": files, "args": [], "dataset": identity}
        submitted = self.request("/v1/jobs", job)
        self.wait_for(lambda: (self.work / "epoch-one.json").is_file(), "first committed training epoch", timeout=45)
        execution = json.loads((self.work / "execution.json").read_text())
        epoch_one = json.loads((self.work / "epoch-one.json").read_text())
        self.assertTrue((self.work / "artifacts/checkpoints" / epoch_one["last_checkpoint"]).is_file())
        self.assertEqual(Path(execution["python"]).absolute(), Path(self.python).absolute())
        self.assertEqual(execution["workspace"], str(self.work))
        self.assertNotEqual(execution["workspace"], str(self.owner))
        self.assertEqual(execution["datasetSha256"], identity["sha256"])
        self.watcher.kill(); self.watcher.wait(timeout=10)
        self.broker.terminate(); self.broker.wait(timeout=10)
        os.kill(execution["pid"], 0)  # Detached training remains alive without either observer.
        original_owner = (self.owner / "transactions.csv").read_bytes()
        (self.owner / "transactions.csv").write_bytes(original_owner + b"changed only after verified staging\n")
        (self.work / "continue-training").touch()
        self.wait_for(lambda: (self.job_directory / "result.json").is_file(), "unobserved training and export evaluation", timeout=30)
        local_result = json.loads((self.job_directory / "result.json").read_text())
        self.assertEqual(local_result["status"], "succeeded", (self.job_directory / "output.log").read_text()[-4000:])
        # Restart the exact same compiled broker store, then repeat the immutable
        # submission before reconnecting its watcher. It cannot launch twice.
        self.launch_broker_after_restart()
        restored = self.request(f"/v1/jobs/{self.job_id}")
        self.assertEqual(restored["status"], "running")
        retried = self.request("/v1/jobs", job)
        self.assertEqual(retried["createdAt"], submitted["createdAt"])
        self.launch_watcher()
        self.wait_for(lambda: self.request(f"/v1/jobs/{self.job_id}")["status"] == "succeeded", "durable completion replay")
        result = json.loads((self.work / "artifacts/results.json").read_text())
        exported = json.loads((self.work / "artifacts/export-evaluation.json").read_text())
        checkpoint = json.loads((self.work / "checkpoint-evidence.json").read_text())
        self.assertEqual(result["epoch"], 2)
        self.assertEqual(checkpoint["epoch"], 2)
        self.assertEqual(checkpoint["history_length"], 2)
        self.assertGreater(checkpoint["global_step"], 0)
        self.assertTrue({"model", "optimizer", "scheduler", "scaler", "rng", "preprocessor"}.issubset(checkpoint["state_keys"]))
        self.assertEqual(exported["test"], result["test"])
        self.assertEqual(exported["run_id"], result["run_id"])
        self.assertEqual(result["provenance"]["dataset_sha256"], data_manifest["sha256"])
        self.assertEqual(result["provenance"]["compute_agent"]["PAIR_NOTEBOOK_DATA_SHA256"], identity["sha256"])
        self.assertEqual(digest(self.work / "transactions.csv"), data_manifest["sha256"])
        self.assertEqual(digest(self.work / "artifacts/inputs/transactions.csv"), data_manifest["sha256"])
        for name, expected in files.items():
            self.assertEqual((self.work / name).read_text(), expected)
        self.assertEqual((self.work / "launch-count.txt").read_text(), "started\n")
        self.assertEqual(len(self.request("/v1/jobs")), 1)
        broker_result = self.request(f"/v1/jobs/{self.job_id}")
        self.assertIn(result["run_id"], base64.b64decode(broker_result["log"]).decode())
        evidence = {"scope": "real-local-loopback-compiled-broker-and-agent", "jobId": self.job_id,
            "status": broker_result["status"], "dataset": identity, "datasetFileSha256": data_manifest["sha256"],
            "sourceSha256": execution["sourceSha256"], "selectedPython": execution["python"],
            "runId": result["run_id"], "epochs": result["epoch"], "globalStep": checkpoint["global_step"],
            "launches": 1, "watcherSigkill": True, "brokerRestart": True, "immutableOwnerData": True,
            "exportMetricsEqual": True, "externalVps": "not-evaluated", "physicalGpu": "not-evaluated",
            "brokerSha256": {name: digest(self.frozen / name) for name in
                ["vps/cli.js", "vps/server.js", "vps/protocol.js", "core/atomicFile.js"]},
            "agentSha256": digest(self.agent_script), "testMetrics": result["test"]}
        (self.root / "evidence.json").write_text(json.dumps(evidence, indent=2, sort_keys=True))
        print(f"Persistent reference integration evidence: {self.root}", flush=True)

    def launch_broker_after_restart(self):
        log = (self.root / "broker.log").open("ab")
        self.handles.append(log)
        env = {**os.environ, "PAIR_VPS_PORT": str(self.port), "PAIR_VPS_BIND": "127.0.0.1",
               "PAIR_VPS_DATA": str(self.root / "broker-state"), "PAIR_VPS_CLIENT_TOKEN": self.team,
               "PAIR_VPS_AGENT_TOKENS": json.dumps({"reference-pc": self.agent_token}),
               "NODE_PATH": str(REPO / "node_modules")}
        env.pop("PAIR_VPS_CLIENT_PRINCIPALS", None)
        self.broker = subprocess.Popen(["node", str(self.frozen / "vps/cli.js")], cwd=REPO, env=env, stdout=log, stderr=log)
        self.wait_for(lambda: len(self.request("/v1/jobs")) == 1, "restarted broker persisted job")


if __name__ == "__main__":
    unittest.main(verbosity=2)
