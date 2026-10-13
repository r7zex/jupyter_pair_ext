"""Interactive agent protocol/isolation tests and an explicitly direct CPU bridge test.

FakeBridge tests exercise broker receipts, not sandbox or CUDA operation. The
real bridge test runs trusted test code directly and does not claim isolation.
The production bubblewrap test skips with the actual platform capability reason.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("session_agent", ROOT / "scripts" / "pair-notebook-session-agent.py")
agent_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent_module)


def command(identifier="cell1", generation=1, source="counter", notebook="session:1:book.ipynb"):
    return {"id": identifier, "executionId": "run-" + identifier, "sessionId": "session", "kernelId": notebook,
            "generation": generation, "deviceId": "pc", "files": [{"path": "data.txt", "content": "aGVsbG8=", "version": 3}],
            "command": {"command": "execute", "requestId": identifier, "codeBase64": base64.b64encode(source.encode()).decode()}}


class FakeBridge:
    """Protocol adapter; never presented as Python, filesystem or CUDA evidence."""
    instances = []

    def __init__(self, sandbox, workspace, gpu_uuid):
        self.workspace = workspace
        self.events = queue.Queue()
        self.baseline = {}
        self.last_used = time.monotonic()
        self.counter = 0
        self.sent = []
        self.closed = False
        self.pending_request = None
        self.__class__.instances.append(self)

    def start(self):
        return {"type": "ready", "pythonExecutable": "fake-protocol-interpreter"}

    def send(self, value):
        self.sent.append(value)
        self.last_used = time.monotonic()
        request_id = value.get("requestId")
        if value["command"] == "execute":
            source = base64.b64decode(value["codeBase64"]).decode()
            self.counter += 1
            self.events.put({"type": "accepted", "requestId": request_id})
            self.events.put({"type": "iopub", "messageType": "stream", "requestId": request_id,
                             "content": {"name": "stdout", "text": str(self.counter)}})
            if source == "wait":
                self.pending_request = request_id
                self.events.put({"type": "inputRequest", "requestId": request_id, "content": {"prompt": "value: "}})
            else:
                self.events.put({"type": "complete", "requestId": request_id, "success": True, "content": {"status": "ok"}})
        elif value["command"] == "inputReply":
            self.events.put({"type": "complete", "requestId": self.pending_request, "success": True, "content": {"status": "ok"}})
        elif value["command"] == "restart":
            self.counter = 0
            self.events.put({"type": "commandResult", "requestId": request_id, "command": "restart"})

    def close(self):
        self.closed = True


class FakeTransport:
    def __init__(self, commands=()):
        self.commands = list(commands)
        self.current = None
        self.calls = []
        self.reports = []
        self.drop_report_ack = False
        self.controls = []
        self.recover_only = False

    def request(self, operation, **body):
        self.calls.append((operation, body))
        if operation == "claim":
            if self.current is None and self.commands:
                self.current = self.commands.pop(0)
            return {"command": self.current, "controls": self.controls, "recoverOnly": self.recover_only}
        if operation == "report":
            self.reports.append(json.loads(json.dumps(body)))
            if self.drop_report_ack:
                self.drop_report_ack = False
                raise OSError("Simulated acknowledgement loss")
            if body["state"] != "running":
                self.current = None
            return {"offset": body["offset"] + len(body["events"])}
        return {"registered": True}


class AgentProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pair-session-agent-test-")
        self.root = Path(self.temporary.name)
        self.agents = []
        FakeBridge.instances = []

    def tearDown(self):
        for agent in self.agents:
            agent.close()
        self.temporary.cleanup()

    def make_agent(self, transport, share=True, ready=True, name="state", max_kernels=2, session="session"):
        args = argparse.Namespace(id="vps" if session is None else "pc", session=session, url="http://127.0.0.1:8787", token_file="unused",
                                  python=sys.executable, bridge=str(ROOT / "media/jupyter_kernel_bridge.py"),
                                  state=str(self.root / name), name="Test device", share=share, max_kernels=max_kernels)
        sandbox = SimpleNamespace(ready=ready, python=sys.executable, gpus=[], cuda_available=False,
                                  reason="fake protocol adapter, not sandbox verification")
        agent = agent_module.SessionAgent(args, transport=transport, sandbox=sandbox, bridge_factory=FakeBridge)
        self.agents.append(agent)
        return agent

    def test_namespace_is_retained_between_cells_on_one_generation(self):
        transport = FakeTransport([command("a"), command("b")])
        agent = self.make_agent(transport)
        agent.tick()
        agent.tick()
        self.assertEqual(len(FakeBridge.instances), 1)
        texts = [event["content"]["text"] for report in transport.reports for event in report["events"] if event["type"] == "iopub"]
        self.assertEqual(texts, ["1", "2"])

    def test_new_generation_closes_old_idle_kernel_and_reports_reset(self):
        transport = FakeTransport([command("a"), command("b", generation=2, notebook="session:2:book.ipynb")])
        agent = self.make_agent(transport)
        agent.tick()
        agent.tick()
        self.assertEqual(len(FakeBridge.instances), 2)
        self.assertTrue(FakeBridge.instances[0].closed)
        resets = [event for report in transport.reports for event in report["events"] if event["type"] == "kernelState"]
        self.assertEqual(len(resets), 2)

    def test_resource_limit_retains_existing_namespace_instead_of_eviction(self):
        transport = FakeTransport([command("a"), command("b", notebook="session:1:other.ipynb")])
        agent = self.make_agent(transport, max_kernels=1)
        agent.tick()
        agent.tick()
        self.assertEqual(len(FakeBridge.instances), 1)
        self.assertFalse(FakeBridge.instances[0].closed)
        self.assertEqual(transport.reports[-1]["state"], "failed")
        self.assertIn("existing variables were retained", transport.reports[-1]["error"])

    def test_running_claim_is_not_written_to_kernel_twice(self):
        transport = FakeTransport([command("a", source="wait")])
        agent = self.make_agent(transport)
        agent.tick()
        agent.tick()
        self.assertEqual(len(FakeBridge.instances[0].sent), 1)

    def test_stdin_control_is_delivered_during_running_cell_once(self):
        transport = FakeTransport([command("a", source="wait")])
        agent = self.make_agent(transport)
        agent.tick()
        transport.controls = [{"id": "control1", "command": {"command": "inputReply", "value": "yes"}}]
        agent.tick()
        self.assertEqual(transport.reports[-1]["state"], "completed")
        self.assertEqual([value["command"] for value in FakeBridge.instances[0].sent], ["execute", "inputReply"])

    def test_lost_report_ack_replays_frozen_exact_payload(self):
        transport = FakeTransport([command("a", source="wait")])
        agent = self.make_agent(transport)
        transport.drop_report_ack = True
        with self.assertRaises(OSError):
            agent.tick()
        failed_payload = transport.reports[-1]
        FakeBridge.instances[0].events.put({"type": "iopub", "requestId": "a", "messageType": "stream", "content": {"text": "later"}})
        agent.tick()
        self.assertEqual(transport.reports[1], failed_payload)
        self.assertTrue(any(event.get("content", {}).get("text") == "later" for event in transport.reports[-1]["events"]))

    def test_crash_receipt_reports_interrupted_without_replaying(self):
        transport = FakeTransport([command("a", source="wait")])
        original = self.make_agent(transport)
        original.tick()
        original.lock.close()  # Simulate process termination without graceful close/report.
        self.agents.remove(original)
        restarted = self.make_agent(transport)
        restarted.tick()
        self.assertEqual(len(FakeBridge.instances), 1)
        self.assertEqual(transport.reports[-1]["state"], "interrupted")
        self.assertIn("not rerun", transport.reports[-1]["error"])

    def test_broker_recovery_without_local_receipt_never_executes(self):
        transport = FakeTransport([command("a")])
        transport.recover_only = True
        agent = self.make_agent(transport)
        agent.tick()
        self.assertEqual(FakeBridge.instances, [])
        self.assertEqual(transport.reports[-1]["state"], "interrupted")

    def test_redacted_recovery_claim_preserves_running_kernel_without_replay(self):
        transport = FakeTransport([command("a", source="wait")])
        agent = self.make_agent(transport)
        agent.tick()
        transport.current = {**transport.current, "files": [], "command": {}}
        transport.recover_only = True
        agent.tick()
        self.assertEqual(len(FakeBridge.instances), 1)
        self.assertEqual(len(FakeBridge.instances[0].sent), 1)
        self.assertEqual(agent.active["receipt"]["state"], "running")

    def test_output_quota_preserves_terminal_and_explicit_limit_notice(self):
        transport = FakeTransport([command("a", source="wait")])
        agent = self.make_agent(transport)
        agent.tick()
        for index in range(20):
            agent._append({"type": "iopub", "requestId": "a", "content": {"text": "x" * (128 * 1024)}})
        agent._append({"type": "complete", "requestId": "a", "success": True, "content": {"status": "ok"}})
        events = agent.active["receipt"]["events"]
        self.assertLess(len(json.dumps(events).encode()), 1024 * 1024)
        self.assertEqual(events[-1]["type"], "complete")
        self.assertTrue(any(event["type"] == "channelError" and "limit" in event["message"] for event in events))

    def test_restart_command_settles_and_explicitly_reports_namespace_reset(self):
        restart = command("restart")
        restart["command"] = {"command": "restart", "requestId": "restart"}
        transport = FakeTransport([command("a"), restart])
        agent = self.make_agent(transport)
        agent.tick()
        agent.tick()
        self.assertEqual(transport.reports[-1]["state"], "completed")
        self.assertEqual(FakeBridge.instances[0].counter, 0)
        self.assertTrue(any(event["type"] == "kernelState" and "clears" in event["message"] for event in transport.reports[-1]["events"]))

    def test_release_closes_only_exact_idle_notebook_and_reports_completion(self):
        release = command("release")
        release["command"] = {"command": "release", "requestId": "release"}
        transport = FakeTransport([command("a"), command("b", notebook="session:1:other.ipynb"), release])
        agent = self.make_agent(transport)
        for _ in range(3):
            agent.tick()
        self.assertTrue(FakeBridge.instances[0].closed)
        self.assertFalse(FakeBridge.instances[1].closed)
        self.assertEqual(len(agent.kernels), 1)
        self.assertEqual(transport.reports[-1]["state"], "completed")
        self.assertEqual([event["type"] for event in transport.reports[-1]["events"]], ["kernelState", "commandResult"])
        self.assertEqual(transport.reports[-1]["events"][-1]["command"], "release")

    def test_release_missing_kernel_never_starts_kernel_or_installs_snapshot(self):
        release = command("release")
        release.pop("files")  # A release requires no execution snapshot.
        release["command"] = {"command": "release", "requestId": "release"}
        transport = FakeTransport([release])
        agent = self.make_agent(transport)
        agent.tick()
        self.assertEqual(FakeBridge.instances, [])
        self.assertFalse((agent.state / "kernels").exists())
        self.assertEqual(transport.reports[-1]["state"], "completed")
        self.assertIn("no live kernel", transport.reports[-1]["events"][0]["message"])

    def test_release_does_not_close_another_generation_or_gpu_key(self):
        original = command("a")
        original["gpuUuid"] = "GPU-12345678-1234-1234-1234-123456789abc"
        another_generation = command("release-generation", generation=2)
        another_generation["gpuUuid"] = original["gpuUuid"]
        another_gpu = command("release-gpu")
        another_gpu["gpuUuid"] = "GPU-22345678-1234-1234-1234-123456789abc"
        for release in (another_generation, another_gpu):
            release["command"] = {"command": "release", "requestId": release["id"]}
        transport = FakeTransport([original, another_generation, another_gpu])
        agent = self.make_agent(transport)
        for _ in range(3):
            agent.tick()
        self.assertEqual(len(FakeBridge.instances), 1)
        self.assertFalse(FakeBridge.instances[0].closed)
        self.assertEqual(len(agent.kernels), 1)

    def test_queued_release_waits_for_accepted_cell_to_finish(self):
        release = command("release")
        release["command"] = {"command": "release", "requestId": "release"}
        transport = FakeTransport([command("a", source="wait"), release])
        agent = self.make_agent(transport)
        agent.tick()
        agent.tick()
        self.assertFalse(FakeBridge.instances[0].closed)
        self.assertEqual(agent.active["receipt"]["identity"]["id"], "a")
        transport.controls = [{"id": "reply", "command": {"command": "inputReply", "value": "yes"}}]
        agent.tick()
        self.assertFalse(FakeBridge.instances[0].closed)
        self.assertIsNone(agent.active)
        transport.controls = []
        agent.tick()
        self.assertTrue(FakeBridge.instances[0].closed)
        self.assertEqual([report["commandId"] for report in transport.reports if report["state"] == "completed"], ["a", "release"])

    def test_deleted_session_retains_accepted_result_then_global_agent_continues(self):
        transport = FakeTransport([command("idle", notebook="session:1:idle.ipynb"), command("a", source="wait")])
        for queued in transport.commands:
            queued["deviceId"] = "vps"
        agent = self.make_agent(transport, session=None)
        agent.tick()
        agent.tick()
        original_request = transport.request
        def deleted_report(operation, **body):
            if operation == "report":
                raise urllib.error.HTTPError("https://vps/report", 404, "Session was deleted", {}, None)
            return original_request(operation, **body)
        transport.request = deleted_report
        agent.tick()
        self.assertEqual(agent.active["receipt"]["state"], "running")
        self.assertFalse(any(bridge.closed for bridge in FakeBridge.instances))
        claims = sum(operation == "claim" for operation, _ in transport.calls)
        agent.tick()
        self.assertEqual(sum(operation == "claim" for operation, _ in transport.calls), claims)
        accepted_bridge = FakeBridge.instances[1]
        accepted_bridge.events.put({"type": "complete", "requestId": "a", "success": True, "content": {"status": "ok"}})
        transport.current = None
        transport.request = original_request
        following = command("next", notebook="other:1:next.ipynb")
        following["sessionId"] = "other"
        following["deviceId"] = "vps"
        transport.commands.append(following)
        agent.tick()
        receipt = json.loads((agent.state / "commands/a/receipt.json").read_text())
        self.assertEqual(receipt["state"], "completed")
        self.assertTrue(receipt["resultRetainedLocally"])
        self.assertEqual(receipt["authorityUnavailable"], "session-deleted")
        self.assertNotIn("pendingReport", receipt)
        self.assertTrue(all(bridge.closed for bridge in FakeBridge.instances[:2]))
        self.assertFalse(agent.credentials_revoked)
        self.assertIsNone(agent.active)
        self.assertEqual(transport.reports[-1]["commandId"], "next")

    def test_report_credentials_revocation_keeps_accepted_cell_running_without_new_claims(self):
        for status in (401, 403):
            with self.subTest(status=status):
                transport = FakeTransport([command("a", source="wait")])
                agent = self.make_agent(transport, name=str(status))
                agent.tick()
                original_request = transport.request
                def revoked(operation, **body):
                    if operation == "report":
                        raise urllib.error.HTTPError("https://vps/report", status, "Credential revoked", {}, None)
                    return original_request(operation, **body)
                transport.request = revoked
                agent.tick()
                bridge = FakeBridge.instances[-1]
                self.assertTrue(agent.credentials_revoked)
                self.assertFalse(bridge.closed)
                calls = len(transport.calls)
                bridge.events.put({"type": "complete", "requestId": "a", "success": True, "content": {"status": "ok"}})
                agent.tick()
                agent.tick()
                self.assertIsNone(agent.active)
                self.assertTrue(bridge.closed)
                self.assertEqual(len(transport.calls), calls)
                receipt = json.loads((agent.state / "commands/a/receipt.json").read_text())
                self.assertEqual(receipt["state"], "completed")
                self.assertTrue(receipt["resultRetainedLocally"])

    def test_heartbeat_authority_loss_does_not_wedge_accepted_run(self):
        for status in (401, 403, 404):
            with self.subTest(status=status):
                transport = FakeTransport([command("a", source="wait")])
                agent = self.make_agent(transport, name="heartbeat-" + str(status))
                agent.tick()
                original_request = transport.request
                def lost_heartbeat(operation, **body):
                    if operation == "registerDevice":
                        raise urllib.error.HTTPError("https://vps/register", status, "Authority unavailable", {}, None)
                    return original_request(operation, **body)
                transport.request = lost_heartbeat
                agent.last_registration = 0
                agent.tick()
                bridge = FakeBridge.instances[-1]
                self.assertFalse(bridge.closed)
                self.assertEqual(agent.active["receipt"]["state"], "running")
                self.assertEqual(agent.session_deleted, status == 404)
                self.assertEqual(agent.credentials_revoked, status in (401, 403))
                calls = len(transport.calls)
                bridge.events.put({"type": "complete", "requestId": "a", "success": True, "content": {"status": "ok"}})
                agent.tick()
                agent.tick()
                self.assertIsNone(agent.active)
                self.assertTrue(bridge.closed)
                self.assertEqual(len(transport.calls), calls)
                self.assertTrue(json.loads((agent.state / "commands/a/receipt.json").read_text())["resultRetainedLocally"])

    def test_no_sharing_and_unavailable_isolation_do_not_claim(self):
        for index, (share, ready) in enumerate(((False, True), (True, False))):
            transport = FakeTransport([command("a")])
            agent = self.make_agent(transport, share=share, ready=ready, name=str(index))
            agent.tick()
            self.assertFalse(any(operation == "claim" for operation, _ in transport.calls))
            registration = next(body for operation, body in transport.calls if operation == "registerDevice")
            self.assertFalse(registration["device"]["enabled"])

    def test_heartbeat_does_not_reenable_revoked_sharing(self):
        transport = FakeTransport()
        agent = self.make_agent(transport)
        agent.register()
        agent.register()
        self.assertEqual(sum(operation == "share" for operation, _ in transport.calls), 1)

    def test_daemon_restart_does_not_reenable_gui_revoked_sharing(self):
        original = self.make_agent(FakeTransport())
        original.register()
        original.close()
        transport = FakeTransport()
        restarted = self.make_agent(transport)
        restarted.register()
        self.assertFalse(any(operation == "share" for operation, _ in transport.calls))

    def test_duplicate_daemon_state_is_locked(self):
        agent = self.make_agent(FakeTransport())
        with self.assertRaisesRegex(agent_module.AgentError, "Another interactive agent"):
            self.make_agent(FakeTransport())
        self.assertFalse(agent.closed)

    def test_snapshot_and_artifact_exclude_host_private_files(self):
        public = self.root / "public"
        public.mkdir()
        private = self.root / "private-token"
        private.write_text("DO-NOT-DISCLOSE")
        baseline = agent_module.install_snapshot(public, [{"path": "data.txt", "content": "aGVsbG8=", "version": 8}])
        (public / "data.txt").write_text("changed")
        (public / "result.txt").write_text("result")
        (public / "token.txt").symlink_to(private)
        (public / "outside").symlink_to(self.root, target_is_directory=True)
        changes, removed, warnings = agent_module.collect_changes(public, baseline)
        self.assertEqual({item["path"] for item in changes}, {"data.txt", "result.txt"})
        self.assertEqual(next(item for item in changes if item["path"] == "data.txt")["version"], 8)
        self.assertEqual(next(item for item in changes if item["path"] == "result.txt")["version"], 0)
        self.assertNotIn("DO-NOT-DISCLOSE", json.dumps(changes))
        self.assertEqual(removed, [])
        self.assertTrue(warnings)
        with self.assertRaises(OSError):
            agent_module.read_workspace_file(public, "outside/private-token")

    def test_snapshot_rejects_traversal_symlink_and_hardlink(self):
        public = self.root / "public"
        public.mkdir()
        for name in ("../token", "/etc/shadow", "safe/../../token", "C:\\token"):
            with self.assertRaises(agent_module.AgentError):
                agent_module.install_snapshot(public, [{"path": name, "content": ""}])
        secret = self.root / "secret"
        secret.write_text("secret")
        (public / "link").symlink_to(secret)
        with self.assertRaises(agent_module.AgentError):
            agent_module.install_snapshot(public, [{"path": "link", "content": ""}])
        os.link(secret, public / "hardlink")
        with self.assertRaises(agent_module.AgentError):
            agent_module.read_workspace_file(public, "hardlink")

    def test_environment_and_sandbox_mounts_withhold_credentials(self):
        with patch.dict(os.environ, {"PAIR_VPS_CLIENT_TOKEN": "secret", "FUTURE_SECRET": "future", "PYTHONPATH": "/private", "CUDA_VISIBLE_DEVICES": "4"}):
            env = agent_module.clean_environment()
        self.assertFalse(any("TOKEN" in key or "SECRET" in key for key in env))
        self.assertNotIn("PYTHONPATH", env)
        sandbox = agent_module.Sandbox.__new__(agent_module.Sandbox)
        sandbox.bwrap, sandbox.python, sandbox.bridge = "/usr/bin/bwrap", "/opt/python/bin/python", ROOT / "media/jupyter_kernel_bridge.py"
        sandbox.roots, sandbox.gpus = [Path("/opt/python")], []
        args = sandbox.command(self.root, None)
        self.assertIn("--unshare-all", args)
        self.assertNotIn("--share-net", args)
        self.assertNotIn("/etc/pair-notebook", args)
        self.assertNotIn("/home", args)
        self.assertNotIn("/", args)
        self.assertEqual(sandbox.environment(None)["CUDA_VISIBLE_DEVICES"], "")
        identity = "GPU-12345678-1234-1234-1234-123456789abc"
        self.assertEqual(sandbox.environment(identity)["CUDA_VISIBLE_DEVICES"], identity)

    def test_root_and_missing_isolation_fail_closed(self):
        if not hasattr(os, "geteuid"):
            self.skipTest("Linux uid check unavailable")
        with patch.object(os, "geteuid", return_value=0):
            sandbox = agent_module.Sandbox(sys.executable, ROOT / "media/jupyter_kernel_bridge.py")
        self.assertFalse(sandbox.ready)
        self.assertIn("non-root", sandbox.reason)

    def test_transport_rejects_public_http_and_redirects(self):
        token = self.root / "token"
        token.write_text("a" * 32)
        for endpoint in ("http://144.172.69.57", "https://user:pass@example.com", "https://example.com?token=x"):
            with self.assertRaises(agent_module.AgentError):
                agent_module.Transport(endpoint, token)
        with self.assertRaises(agent_module.AgentError):
            agent_module.NoRedirect().redirect_request(None, None, None, None, None, None)


class RealRuntimeTests(unittest.TestCase):
    def python(self):
        return os.environ.get("PAIR_NOTEBOOK_TEST_PYTHON", sys.executable)

    def test_production_bubblewrap_cpu_smoke_when_supported(self):
        sandbox = agent_module.Sandbox(self.python(), ROOT / "media/jupyter_kernel_bridge.py")
        if not sandbox.ready:
            if os.environ.get("PAIR_NOTEBOOK_REQUIRE_SANDBOX") == "1":
                self.fail("Required production sandbox unavailable: " + sandbox.reason)
            self.skipTest("Actual production sandbox unavailable: " + sandbox.reason)
        with tempfile.TemporaryDirectory(prefix="pair-real-sandbox-") as temporary:
            private = Path(temporary) / "private-canary.txt"
            private.write_text("private-host-canary")
            workspace = Path(temporary) / "public"
            workspace.mkdir()
            with patch.dict(os.environ, {"PAIR_PRIVATE_CANARY_TOKEN": "private-env-canary"}):
                bridge = agent_module.Bridge(sandbox, workspace, None)
            try:
                bridge.start()
                code = ("import os,sys,torch;assert os.geteuid()!=0;"
                        "assert os.environ['CUDA_VISIBLE_DEVICES']=='';"
                        "assert 'PAIR_PRIVATE_CANARY_TOKEN' not in os.environ;"
                        "assert not os.path.exists('/etc/shadow');assert not os.path.exists('/home');"
                        f"assert not os.path.exists({str(private)!r});"
                        f"assert sys.executable=={sandbox.python!r};"
                        "assert not torch.cuda.is_available();assert torch.cuda.device_count()==0;"
                        "assert torch.ones(4).sum().item()==4.0")
                bridge.send({"command": "execute", "requestId": "sandbox-cpu", "codeBase64": base64.b64encode(
                    code.encode()).decode()})
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    event = bridge.events.get(timeout=5)
                    if event.get("type") == "complete":
                        self.assertTrue(event["success"])
                        return
                self.fail("Isolated cell did not finish")
            finally:
                bridge.close()

    def test_real_direct_cpu_bridge_state_stdin_restart_and_cuda_mask(self):
        """Trusted direct bridge integration; explicitly NOT isolation or GPU proof."""
        python = self.python()
        try:
            subprocess.run([python, "-I", "-c", "import jupyter_client,ipykernel"], capture_output=True, timeout=5, check=True)
        except (OSError, subprocess.SubprocessError):
            self.skipTest("Actual Jupyter dependencies absent from selected test Python")
        with tempfile.TemporaryDirectory(prefix="pair-real-direct-cpu-") as temporary:
            env = {**os.environ, "CUDA_VISIBLE_DEVICES": "", "PAIR_NOTEBOOK_CWD": temporary, "PYTHONUNBUFFERED": "1"}
            process = subprocess.Popen([python, "-I", str(ROOT / "media/jupyter_kernel_bridge.py")], env=env,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            events = queue.Queue()
            def read():
                for line in process.stdout:
                    events.put(json.loads(line))
                events.put({"type": "exited"})
            import threading
            threading.Thread(target=read, daemon=True).start()
            def wait(kind, request_id=None):
                found = []
                deadline = time.monotonic() + 40
                while time.monotonic() < deadline:
                    event = events.get(timeout=max(0.1, deadline - time.monotonic()))
                    found.append(event)
                    if event.get("type") in ("fatal", "exited"):
                        diagnostic = str(event)
                        if "Operation not permitted" in diagnostic or "Permission denied" in diagnostic:
                            self.skipTest("Actual Jupyter socket capability denied: " + diagnostic)
                        self.fail("Actual bridge failed: " + diagnostic)
                    if event.get("type") == kind and (request_id is None or event.get("requestId") == request_id):
                        return event, found
                self.fail("Actual bridge event timed out")
            def send(value):
                process.stdin.write(json.dumps(value) + "\n")
                process.stdin.flush()
            def execute(request_id, source):
                send({"command": "execute", "requestId": request_id, "codeBase64": base64.b64encode(source.encode()).decode()})
                event, found = wait("complete", request_id)
                self.assertTrue(event["success"], str(found))
                return found
            try:
                wait("ready")
                execute("one", "import os\nassert os.environ['CUDA_VISIBLE_DEVICES']==''\nvalue=41")
                output = execute("two", "print(value+1)")
                self.assertTrue(any(event.get("messageType") == "stream" and "42" in event.get("content", {}).get("text", "") for event in output))
                send({"command": "execute", "requestId": "stdin", "codeBase64": base64.b64encode(b"answer=input('value: ');assert answer=='confirmed'").decode()})
                wait("inputRequest", "stdin")
                send({"command": "inputReply", "value": "confirmed"})
                self.assertTrue(wait("complete", "stdin")[0]["success"])
                send({"command": "restart", "requestId": "restart"})
                wait("commandResult", "restart")
                execute("after-restart", "import os\nassert 'value' not in globals()\nassert os.environ['CUDA_VISIBLE_DEVICES']==''")
            finally:
                if process.poll() is None:
                    send({"command": "shutdown"})
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                for stream in (process.stdin, process.stdout, process.stderr):
                    stream.close()


if __name__ == "__main__":
    unittest.main()
