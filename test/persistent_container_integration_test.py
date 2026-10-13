"""Required REAL Linux-container acceptance. Native macOS/Windows are separate evidence.

Requires PAIR_NOTEBOOK_CONTAINER_IMAGE_FILE containing an installed immutable
image ID. Missing Docker/image/readiness FAILS; this suite never silently skips.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("container_agent", ROOT / "scripts/pair-notebook-session-agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

class RealContainerIntegration(unittest.TestCase):
    def test_actual_runtime_isolation_selected_environment_resources_and_stateful_kernel(self):
        image_file = os.environ.get("PAIR_NOTEBOOK_CONTAINER_IMAGE_FILE")
        self.assertTrue(image_file, "Required immutable container image prerequisite is missing")
        sandbox = agent.ContainerSandbox(Path(image_file).read_text().strip(), "/opt/pair-python/bin/python", ROOT / "media/jupyter_kernel_bridge.py")
        self.assertTrue(sandbox.ready, sandbox.reason)
        with tempfile.TemporaryDirectory(prefix="pair-real-container-") as directory:
            root = Path(directory); workspace = root / "work"; workspace.mkdir(mode=0o777); workspace.chmod(0o777)
            secret = root / "credential-canary"; secret.write_text("host private token")
            bridge = agent.Bridge(sandbox, workspace, None)
            try:
                ready = bridge.start(); self.assertEqual(ready["pythonExecutable"], "/opt/pair-python/bin/python")
                name = sandbox.containers[str(workspace.resolve())]
                inspected = json.loads(subprocess.run([sandbox.docker, "inspect", name], check=True, capture_output=True, text=True).stdout)[0]
                host = inspected["HostConfig"]
                self.assertEqual(host["NetworkMode"], "none"); self.assertTrue(host["ReadonlyRootfs"])
                self.assertEqual(host["Memory"], 512 * 1024 * 1024); self.assertEqual(host["NanoCpus"], 1000000000)
                self.assertEqual(inspected["Config"]["User"], f"{sandbox.uid}:{sandbox.gid}")
                self.assertEqual({mount["Destination"] for mount in inspected["Mounts"] if mount["Type"] == "bind"}, {"/work", "/bridge.py"})
                code = (f"import os,pathlib,socket\nassert os.getuid()=={sandbox.uid}\n"
                        f"assert not pathlib.Path({str(secret)!r}).exists()\n"
                        "assert os.environ.get('CUDA_VISIBLE_DEVICES')==''\n"
                        "assert not os.environ.get('PAIR_TEST_SECRET')\n"
                        "try:\n socket.create_connection(('1.1.1.1',443),timeout=1);raise AssertionError('network escaped')\n"
                        "except OSError: pass\nvalue=41\nprint('isolated-ready')")
                self.execute(bridge, "first", code)
                self.execute(bridge, "second", "assert value==41\nvalue+=1\nprint(value)")
                evidence = {"platform": os.sys.platform, "runtime": "Linux container (not native macOS/Windows acceptance)", "image": sandbox.image,
                            "python": ready["pythonExecutable"], "uid": sandbox.uid, "network": host["NetworkMode"], "memoryBytes": host["Memory"], "nanoCpus": host["NanoCpus"],
                            "bindMounts": [mount["Destination"] for mount in inspected["Mounts"] if mount["Type"] == "bind"], "statefulCells": 2, "gpu": False}
                target = os.environ.get("PAIR_CONTAINER_EVIDENCE")
                if target: Path(target).write_text(json.dumps(evidence, indent=2) + "\n")
            finally:
                bridge.close()
                self.assertEqual(sandbox.containers, {})

    def execute(self, bridge, identifier, source):
        bridge.send({"command": "execute", "requestId": identifier, "codeBase64": base64.b64encode(source.encode()).decode()})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try: event = bridge.events.get(timeout=1)
            except queue.Empty: continue
            if event.get("type") == "complete" and event.get("requestId") == identifier:
                self.assertTrue(event.get("success"), str(event)); return
            if event.get("type") in ("fatal", "bridgeExited"): self.fail(str(event))
        self.fail("Real container kernel did not complete")

if __name__ == '__main__': unittest.main()
