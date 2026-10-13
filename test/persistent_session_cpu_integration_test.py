"""Trusted CPU integration: HTTP VPS Host -> SessionAgent -> real Jupyter -> saved notebook.

DirectSandbox is a test-only process adapter for trusted code. This test proves
the real broker/agent/kernel protocol, state, admission recovery and saved
results and actual PyTorch CPU tensors when installed; it does NOT prove
production bubblewrap isolation or NVIDIA/CUDA.
Compile TypeScript first and optionally set PAIR_NOTEBOOK_TEST_PYTHON to an
actual selected interpreter containing jupyter_client and ipykernel.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cpu_integration_agent", ROOT / "scripts/pair-notebook-session-agent.py")
AGENT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AGENT)
ADMIN_TOKEN = "A" * 40
AGENT_TOKEN = "B" * 40
PASSWORD = "trusted CPU integration password"


class DirectSandbox:
    """Trusted integration adapter. Never a production isolation fallback."""
    ready = True
    gpus = []
    cuda_available = False
    reason = "Trusted direct CPU test adapter; no filesystem isolation or CUDA verification"

    def __init__(self, selected_python, home):
        self.python = selected_python
        self.home = home
        home.mkdir()

    def command(self, workspace, gpu_uuid):
        if gpu_uuid:
            raise AssertionError("This integration test only supports real CPU execution")
        self.workspace = workspace
        return [self.python, "-I", str(ROOT / "media/jupyter_kernel_bridge.py")]

    def environment(self, gpu_uuid):
        environment = AGENT.clean_environment()
        environment.update({"CUDA_VISIBLE_DEVICES": "", "HOME": str(self.home),
                            "PAIR_NOTEBOOK_CWD": str(self.workspace), "PAIR_NOTEBOOK_WORKSPACE": str(self.workspace)})
        return environment


class RealHostCpuIntegration(unittest.TestCase):
    def setUp(self):
        if sys.platform != "linux":
            self.skipTest("Actual SessionAgent currently requires Linux")
        self.python = os.environ.get("PAIR_NOTEBOOK_TEST_PYTHON", sys.executable)
        self.node = shutil.which("node")
        self.server_module = ROOT / "out/src/vps/server.js"
        if not self.node or not self.server_module.is_file():
            self.skipTest("Actual compiled VPS Host unavailable; run npm run compile first")
        try:
            subprocess.run([self.python, "-I", "-c",
                            "import jupyter_client,ipykernel,socket;s=socket.socket();s.bind(('127.0.0.1',0));s.close()"],
                           check=True, capture_output=True, timeout=10)
        except (OSError, subprocess.SubprocessError) as error:
            self.skipTest("Actual selected Python/Jupyter or loopback socket capability unavailable: " + str(error))
        self.temporary = tempfile.TemporaryDirectory(prefix="pair-real-host-cpu-")
        self.directory = Path(self.temporary.name)
        self.server = None
        self.agent = None
        self.token_file = self.directory / "agent-token"
        self.token_file.write_text(AGENT_TOKEN)
        self.token_file.chmod(0o600)
        self.start_server()

    def tearDown(self):
        if self.agent:
            self.agent.close()
        self.stop_server()
        self.temporary.cleanup()

    def start_server(self):
        # Use real compiled VpsServer and a durable temporary store across child restarts.
        source = """
const {VpsServer} = require(process.env.PAIR_TEST_SERVER);
const server = new VpsServer({dataDirectory: process.env.PAIR_TEST_STORE,
  clientToken: 'A'.repeat(40), agentTokens: {vps: 'B'.repeat(40)}});
let closing = false;
async function stop() { if (closing) return; closing = true; await server.stop(); process.exit(0); }
require('node:readline').createInterface({input: process.stdin}).on('line', (line) => {
  if (line === 'stop') stop().catch((error) => { console.error(error); process.exit(1); });
});
process.on('SIGTERM', () => stop().catch(() => process.exit(1)));
server.start().then((port) => console.log(JSON.stringify({port}))).catch((error) => {
  console.error(error); process.exit(1);
});
"""
        environment = {**os.environ, "PAIR_TEST_SERVER": str(self.server_module),
                       "PAIR_TEST_STORE": str(self.directory / "server")}
        self.server = subprocess.Popen([self.node, "-e", source], env=environment, text=True,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        lines = queue.Queue()
        def read_lines():
            for line in self.server.stdout:
                lines.put(line)
            lines.put(None)
        threading.Thread(target=read_lines, daemon=True).start()
        try:
            line = lines.get(timeout=10)
            self.assertIsNotNone(line, "Actual VPS Host exited before listening")
            self.endpoint = "http://127.0.0.1:" + str(json.loads(line)["port"])
        except (queue.Empty, ValueError, AssertionError):
            self.server.terminate()
            self.server.wait(timeout=10)
            self.fail("Actual VPS Host could not start: " + self.server.stderr.read())

    def stop_server(self):
        if self.server is None:
            return
        if self.server.poll() is None:
            self.server.stdin.write("stop\n")
            self.server.stdin.flush()
            try:
                self.server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.server.wait(timeout=5)
                self.fail("Actual VPS Host did not stop within the integration deadline")
        for stream in (self.server.stdin, self.server.stdout, self.server.stderr):
            stream.close()
        self.server = None

    def rpc(self, operation, token=None, **fields):
        body = {"operation": operation, **fields}
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(self.endpoint + "/v1/sessions/rpc", method="POST", headers=headers,
                                         data=json.dumps(body).encode())
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
            return json.load(response)

    def owner_rpc(self, operation, **fields):
        return self.rpc(operation, self.owner["token"], sessionId=self.owner["sessionId"], **fields)

    def pump(self, condition, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.agent.tick()
            if condition():
                return
            time.sleep(0.03)
        self.fail("Actual HTTP/agent/Jupyter flow did not finish before the bounded integration deadline")

    def launch(self, cell_index, request_id):
        snapshot = self.owner_rpc("snapshot")
        return self.owner_rpc("execute", notebook="work.ipynb", cellIndex=cell_index,
                              expectedRevision=snapshot["revision"], requestId=request_id)

    def finish(self, cell_index, request_id):
        execution = self.launch(cell_index, request_id)
        self.pump(lambda: self.agent.active is None)
        result = self.owner_rpc("execution", executionId=execution["id"])
        self.assertEqual(result["state"], "completed", str(result))
        return result

    def test_real_private_namespace_imports_outputs_and_declassification_reset(self):
        self.owner = self.rpc("create", ADMIN_TOKEN, name="Private real kernel", password=PASSWORD)
        self.agent = AGENT.SessionAgent(argparse.Namespace(
            id="vps", session=None, url=self.endpoint, token_file=str(self.token_file), python=self.python,
            bridge=str(ROOT / "media/jupyter_kernel_bridge.py"), state=str(self.directory / "agent"),
            name="Actual Private/Public CPU", share=True, max_kernels=1),
            sandbox=DirectSandbox(self.python, self.directory / "direct-test-home"))
        self.agent.tick()
        source = "from secretdep import secret\nprivate_value=secret\nprint(private_value)"
        notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [{"id": "private", "cell_type": "code", "source": source, "metadata": {}, "outputs": [], "execution_count": None}]}
        snap = self.owner_rpc("snapshot")
        snap = self.owner_rpc("write", path="work.ipynb", content=base64.b64encode(json.dumps(notebook).encode()).decode(), expectedRevision=snap["revision"])
        snap = self.owner_rpc("visibility", path="work.ipynb", visibility="private", expectedRevision=snap["revision"])
        snap = self.owner_rpc("write", path="secretdep.py", content=base64.b64encode(b"secret='private-canary'").decode(), expectedRevision=snap["revision"])
        self.owner_rpc("visibility", path="secretdep.py", visibility="private", expectedRevision=snap["revision"])
        result = self.finish(0, "actual-private")
        self.assertEqual(result["scope"], "private")
        saved = json.loads(base64.b64decode(self.owner_rpc("read", path="work.ipynb")["content"]))
        self.assertIn("private-canary", json.dumps(saved["cells"][0]["outputs"]))
        snap = self.owner_rpc("snapshot")
        self.owner_rpc("visibility", path="work.ipynb", visibility="public", expectedRevision=snap["revision"])
        published = json.loads(base64.b64decode(self.owner_rpc("read", path="work.ipynb")["content"]))
        self.assertEqual(published["cells"][0]["outputs"], [])
        published["cells"][0]["source"] = "assert 'private_value' not in globals()\nimport pathlib\nassert not pathlib.Path('secretdep.py').exists()\nprint('public-reset')"
        snap = self.owner_rpc("snapshot")
        self.owner_rpc("write", path="work.ipynb", content=base64.b64encode(json.dumps(published).encode()).decode(), expectedRevision=snap["revision"])
        public = self.finish(0, "actual-public-reset")
        self.assertEqual(public["scope"], "public")
        self.assertEqual(len(self.agent.kernels), 1)
        self.assertTrue(any(event.get("type") == "kernelState" for event in public["events"]))

    def test_notebook_rename_retires_old_namespace_and_reuses_single_kernel_capacity(self):
        self.owner = self.rpc("create", ADMIN_TOKEN, name="Notebook rename", password=PASSWORD)
        self.agent = AGENT.SessionAgent(argparse.Namespace(
            id="vps", session=None, url=self.endpoint, token_file=str(self.token_file), python=self.python,
            bridge=str(ROOT / "media/jupyter_kernel_bridge.py"), state=str(self.directory / "agent"),
            name="Single-kernel CPU", share=True, max_kernels=1),
            sandbox=DirectSandbox(self.python, self.directory / "direct-test-home"))
        self.agent.tick()
        source = "counter=globals().get('counter',0)+1;print(counter)"
        notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [
            {"id": "rename-cell", "cell_type": "code", "source": source, "metadata": {},
             "execution_count": None, "outputs": []}]}
        self.owner_rpc("write", path="work.ipynb", content=base64.b64encode(json.dumps(notebook).encode()).decode(), expectedRevision=0)
        first = self.finish(0, "before-rename")
        snapshot = self.owner_rpc("snapshot")
        self.owner_rpc("rename", path="work.ipynb", newPath="renamed.ipynb", expectedRevision=snapshot["revision"])
        snapshot = self.owner_rpc("snapshot")
        second = self.owner_rpc("execute", notebook="renamed.ipynb", cellIndex=0,
                                expectedRevision=snapshot["revision"], requestId="after-rename")
        self.pump(lambda: self.agent.active is None)
        result = self.owner_rpc("execution", executionId=second["id"])
        self.assertEqual(result["state"], "completed", str(result))
        self.assertGreater(result["generation"], first["generation"])
        self.assertEqual(len(self.agent.kernels), 1)
        saved = self.owner_rpc("read", path="renamed.ipynb")
        outputs = json.loads(base64.b64decode(saved["content"]))["cells"][0]["outputs"]
        self.assertEqual(outputs[0]["text"], "1\n")
        self.assertTrue(any(event["type"] == "kernelState" and "fresh" in event["message"] for event in result["events"]))

    def test_actual_http_transport_receives_large_admitted_command_without_wedging_worker(self):
        """Wire-limit regression only: no kernel, sandbox or GPU execution claimed."""
        self.owner = self.rpc("create", ADMIN_TOKEN, name="Command transport limit", password=PASSWORD)
        self.rpc("registerDevice", AGENT_TOKEN, deviceId="vps", device={
            "id": "vps", "name": "Transport-only test inventory", "python": self.python,
            "cpu": "CPU", "gpus": [], "isolation": "transport-only fixture", "ready": True})
        source = "#" + "x" * (4 * 1024 * 1024 - 4096)
        notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [
            {"id": "large-comment", "cell_type": "code", "source": source, "metadata": {},
             "execution_count": None, "outputs": []}]}
        self.owner_rpc("write", path="work.ipynb", content=base64.b64encode(json.dumps(notebook).encode()).decode(), expectedRevision=0)
        execution = self.launch(0, "large-transport-command")
        transport = AGENT.Transport(self.endpoint, token_file=self.token_file)
        response = transport.request("claim", deviceId="vps")
        command = response["command"]
        self.assertGreater(len(json.dumps(response).encode()), 10 * 1024 * 1024)
        self.assertEqual(command["executionId"], execution["id"])
        self.assertEqual(base64.b64decode(command["command"]["codeBase64"]).decode(), source)
        # Deliberately do not execute this transport fixture. Release accepted
        # authority explicitly, proving the shared worker can accept other work.
        transport.request("report", sessionId=self.owner["sessionId"], deviceId="vps",
                          executionId=command["executionId"], commandId=command["id"],
                          generation=command["generation"], offset=0, state="interrupted", events=[],
                          error="Transport-only regression: no kernel execution attempted")
        self.assertIsNone(transport.request("claim", deviceId="vps")["command"])

    def test_real_selected_python_pytorch_cpu_tensor_output_is_saved(self):
        installed = subprocess.run([self.python, "-I", "-c",
                                    "import importlib.util;raise SystemExit(0 if importlib.util.find_spec('torch') else 2)"],
                                   capture_output=True, timeout=10)
        if installed.returncode == 2:
            self.skipTest("Actual PyTorch dependency absent from the selected Python; no tensor or CUDA result was simulated")
        self.assertEqual(installed.returncode, 0, installed.stderr.decode(errors="replace"))
        self.owner = self.rpc("create", ADMIN_TOKEN, name="Actual PyTorch CPU flow", password=PASSWORD)
        self.agent = AGENT.SessionAgent(argparse.Namespace(
            id="vps", session=None, url=self.endpoint, token_file=str(self.token_file), python=self.python,
            bridge=str(ROOT / "media/jupyter_kernel_bridge.py"), state=str(self.directory / "agent"),
            name="Real PyTorch CPU Python", share=True, max_kernels=2),
            sandbox=DirectSandbox(self.python, self.directory / "direct-test-home"))
        self.agent.tick()
        source = ("import os,json,torch\nassert os.environ['CUDA_VISIBLE_DEVICES']==''\n"
                  "assert torch.cuda.is_available() is False\ntorch.set_num_threads(1)\n"
                  "tensor=torch.arange(1,5,dtype=torch.float32,device='cpu')\n"
                  "assert tensor.sum().item()==10\nassert str(tensor.device)=='cpu'\n"
                  "print(json.dumps({'torchVersion':torch.__version__,'device':str(tensor.device),"
                  "'sum':tensor.sum().item(),'cudaAvailable':torch.cuda.is_available(),"
                  "'cudaDeviceCount':torch.cuda.device_count()}))")
        notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [
            {"id": "actual-tensor", "cell_type": "code", "source": source, "metadata": {},
             "execution_count": None, "outputs": []}]}
        self.owner_rpc("write", path="work.ipynb", content=base64.b64encode(json.dumps(notebook).encode()).decode(), expectedRevision=0)
        result = self.finish(0, "actual-pytorch-cpu")
        self.assertTrue(any(event["type"] == "kernelState" and event.get("pythonExecutable") == self.python for event in result["events"]))
        saved = self.owner_rpc("read", path="work.ipynb")
        outputs = json.loads(base64.b64decode(saved["content"]))["cells"][0]["outputs"]
        text = "".join(output["text"] for output in outputs if output.get("output_type") == "stream" and output.get("name") == "stdout")
        actual = json.loads(text)
        self.assertTrue(actual["torchVersion"])
        self.assertEqual(actual["device"], "cpu")
        self.assertEqual(actual["sum"], 10.0)
        self.assertFalse(actual["cudaAvailable"])
        self.assertEqual(actual["cudaDeviceCount"], 0)
        print("Actual Jupyter PyTorch CPU result: " + json.dumps(actual, sort_keys=True), flush=True)

    def test_real_stateful_cpu_saved_results_offline_owner_and_broker_restart(self):
        self.owner = self.rpc("create", ADMIN_TOKEN, name="Actual CPU flow", password=PASSWORD)
        self.agent = AGENT.SessionAgent(argparse.Namespace(
            id="vps", session=None, url=self.endpoint, token_file=str(self.token_file), python=self.python,
            bridge=str(ROOT / "media/jupyter_kernel_bridge.py"), state=str(self.directory / "agent"),
            name="Real selected CPU Python", share=True, max_kernels=2),
            sandbox=DirectSandbox(self.python, self.directory / "direct-test-home"))
        self.agent.tick()
        sources = [
            "import os,sys\nfrom pathlib import Path\nassert os.environ['CUDA_VISIBLE_DEVICES']==''\n"
            "assert not Path('secret').exists()\nassert Path('shared.txt').read_text()=='public dependency'\n"
            "counter=41\nprint(counter)",
            "counter+=1\nprint(counter)",
            "import time\naccepted_count=Path('accepted-count.txt')\n"
            "accepted_count.write_text(str(int(accepted_count.read_text())+1) if accepted_count.exists() else '1')\n"
            "counter+=1\nwhile not Path('continue.flag').exists():\n    time.sleep(0.03)\nprint(counter)",
            "assert 'counter' not in globals()\nprint('new generation reset verified')",
        ]
        notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [
            {"id": "stable-" + str(index), "cell_type": "code", "source": source, "metadata": {},
             "execution_count": None, "outputs": []} for index, source in enumerate(sources)]}
        encode = lambda content: base64.b64encode(content.encode()).decode()
        snapshot = self.owner_rpc("write", path="work.ipynb", content=encode(json.dumps(notebook)), expectedRevision=0)
        snapshot = self.owner_rpc("write", path="shared.txt", content=encode("public dependency"), expectedRevision=snapshot["revision"])
        snapshot = self.owner_rpc("mkdir", path="secret", visibility="private", expectedRevision=snapshot["revision"])
        self.owner_rpc("write", path="secret/private.py", content=encode("OWNER-ONLY-SENTINEL"), expectedRevision=snapshot["revision"])
        first = self.finish(0, "actual-first")
        self.assertTrue(any(event["type"] == "kernelState" and event.get("pythonExecutable") == self.python for event in first["events"]))
        original_bridge = next(iter(self.agent.kernels.values()))
        original_pid = original_bridge.process.pid
        self.finish(1, "actual-second")
        self.assertEqual(len(self.agent.kernels), 1)
        self.assertEqual(original_bridge.process.pid, original_pid)
        self.assertFalse((original_bridge.workspace / "secret").exists())
        running = self.launch(2, "actual-accepted")
        accepted_marker = original_bridge.workspace / "accepted-count.txt"
        self.pump(lambda: self.agent.active is not None and accepted_marker.exists() and accepted_marker.read_text() == "1")
        command_id = self.agent.active["receipt"]["identity"]["id"]
        self.assertEqual((original_bridge.workspace / "accepted-count.txt").read_text(), "1")
        self.assertEqual(self.owner_rpc("leave"), {"left": True})
        # No member API calls occur until the accepted run has completed below.
        self.stop_server()
        with self.assertRaises(OSError):
            self.agent.tick()
        self.assertIsNone(original_bridge.process.poll())
        self.start_server()
        self.agent.transport = AGENT.Transport(self.endpoint, self.token_file)
        self.agent.last_registration = 0
        self.agent.tick()
        self.assertEqual(self.agent.active["receipt"]["identity"]["id"], command_id)
        self.assertIsNone(original_bridge.process.poll())
        self.assertEqual(original_bridge.process.pid, original_pid)
        self.assertEqual((original_bridge.workspace / "accepted-count.txt").read_text(), "1")
        (original_bridge.workspace / "continue.flag").write_text("finish accepted execution")
        self.pump(lambda: self.agent.active is None)
        receipt = json.loads((self.agent.state / "commands" / command_id / "receipt.json").read_text())
        self.assertEqual(receipt["state"], "completed")
        self.assertEqual((original_bridge.workspace / "accepted-count.txt").read_text(), "1")
        reconnected = self.rpc("join", sessionId=self.owner["sessionId"], password=PASSWORD, name="Reconnected guest")
        restored = self.rpc("read", reconnected["token"], sessionId=self.owner["sessionId"], path="work.ipynb")
        saved = json.loads(base64.b64decode(restored["content"]))
        for index, expected in enumerate(("41\n", "42\n", "43\n")):
            self.assertEqual(saved["cells"][index]["outputs"][0]["text"], expected)
        recovered = self.owner_rpc("execution", executionId=running["id"])
        self.assertEqual(recovered["state"], "completed")
        completed = [event for event in recovered["events"] if event["type"] == "complete"]
        self.assertEqual(len(completed), 1)
        artifact = self.owner_rpc("read", path="accepted-count.txt")
        self.assertEqual(base64.b64decode(artifact["content"]).decode(), "1")
        reset = self.finish(3, "actual-next-generation")
        self.assertGreater(reset["generation"], recovered["generation"])
        self.assertTrue(any(event["type"] == "kernelState" and "fresh Python kernel" in event["message"] for event in reset["events"]))
        self.assertIsNotNone(original_bridge.process.poll())
        final = self.owner_rpc("read", path="work.ipynb")
        saved = json.loads(base64.b64decode(final["content"]))
        self.assertEqual(saved["cells"][3]["outputs"][0]["text"], "new generation reset verified\n")


if __name__ == "__main__":
    unittest.main()
