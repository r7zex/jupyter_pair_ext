"""Real offline bubblewrap kernel and explicit wheel installation, no production sessions."""
import argparse
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", required=True)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--baseline", action="store_true")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("acceptance_agent", args.root / "scripts/pair-notebook-session-agent.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sandbox = module.Sandbox(args.python, str(args.root / "media/jupyter_kernel_bridge.py"))
    if not sandbox.ready:
        raise RuntimeError(sandbox.reason)
    class BrokerBoundary:
        def request(self, operation, **body):
            return {"offset": body.get("offset", 0) + len(body.get("events", []))}
    with tempfile.TemporaryDirectory(prefix="pair-packages-acceptance-") as temporary:
        state = Path(temporary) / "state"
        config = argparse.Namespace(id="vps", session=None, url="http://127.0.0.1:1", token_file=None,
                                    python=args.python, bridge=str(args.root / "media/jupyter_kernel_bridge.py"),
                                    state=str(state), name="Isolated acceptance", share=True, max_kernels=4)
        agent = module.SessionAgent(config, transport=BrokerBoundary(), sandbox=sandbox)
        sequence = 0
        def execute(code, command="execute", generation=1, notebook="first", scope="public", session="acceptance"):
            nonlocal sequence
            sequence += 1
            identifier = f"run-{sequence}"
            request = {"id": identifier, "executionId": identifier, "sessionId": session,
                       "kernelId": f"{session}:{scope}:{generation}:{notebook}",
                       "generation": generation, "deviceId": "vps", "scope": scope, "files": [],
                       "command": {"command": command, "requestId": identifier, "codeBase64": base64.b64encode(code.encode()).decode()}}
            agent._claim(request)
            deadline = time.monotonic() + 90
            while agent.active["receipt"]["state"] == "running" and time.monotonic() < deadline:
                agent._drain()
                time.sleep(.02)
            receipt = agent.active["receipt"]
            print(json.dumps({"step": sequence, "command": command, "state": receipt["state"], "events": receipt["events"], "error": receipt.get("error")}), flush=True)
            return receipt
        try:
            diagnostic = execute("import sys,ssl,os,json; print(json.dumps({'executable':sys.executable,'prefix':sys.prefix,'uid':os.getuid(),'ca':ssl.get_default_verify_paths().cafile})); import socket; s=socket.socket(); s.settimeout(.2); print('network namespace remains isolated')")
            assert diagnostic["state"] == "completed"
            result = execute("import importlib.util; assert importlib.util.find_spec('numpy') is None; marker = 84", notebook="second")
            assert result["state"] == "completed", "Select a test runtime without preinstalled NumPy."
            result = execute("%pip install numpy")
            if args.baseline:
                return
            assert result["state"] == "completed", result.get("error")
            result = execute("import numpy as np; print(np.arange(10)); marker = 42")
            assert result["state"] == "completed"
            assert "0 1 2 3 4 5 6 7 8 9" in json.dumps(result["events"])
            result = execute("from __future__ import annotations\nimport numpy as np; print(np.arange(3)); assert marker == 84", notebook="second")
            assert result["state"] == "completed", result
            result = execute("import numpy as np; print(np.arange(3)); assert 'marker' not in globals()", notebook="third")
            assert result["state"] == "completed", result
            environment = sandbox.package_root / "current"
            (environment / "extra").mkdir()
            (environment / "extra/session_extra.py").write_text("value = 123")
            (environment / "session-extra.pth").write_text("extra\n")
            assert execute("%pip install six", notebook="third")["state"] == "completed"
            result = execute("import session_extra; assert session_extra.value == 123; assert marker == 84", notebook="second")
            assert result["state"] == "completed", result
            assert execute("", "restart", 2)["state"] == "completed"
            result = execute("import numpy as np; print(np.arange(10)); print('marker' in globals())", generation=2)
            assert result["state"] == "completed"
            assert "False" in json.dumps(result["events"])
            result = execute("%pip install pair-notebook-nonexistent-package-acceptance-0611", generation=2)
            assert result["state"] == "failed"
            assert execute("import numpy as np; print(np.arange(3))", generation=2)["state"] == "completed"
            assert execute("import importlib.util; assert importlib.util.find_spec('numpy') is None", generation=2, scope="private")["state"] == "completed"
            assert execute("import importlib.util; assert importlib.util.find_spec('numpy') is None", generation=2, session="other-session")["state"] == "completed"
            agent.close()
            agent = module.SessionAgent(config, transport=BrokerBoundary(), sandbox=sandbox)
            result = execute("import numpy as np; print(np.arange(3))", generation=3, notebook="recreated-notebook")
            assert result["state"] == "completed", result
            assert len(list((state / "packages").iterdir())) == 3
            print(json.dumps({"result": "passed", "nonRoot": True, "network": "offline kernel; wheel downloader only",
                              "restartPreservedPackages": True, "oneInstallSharedByThreeNotebooks": True,
                              "alreadyOpenKernelSeesInstall": True, "kernelVariablesRemainIndependent": True,
                              "publishedPthDiscoveredByRunningKernel": True,
                              "generationAndAgentRestartPreservedPackages": True, "sessionAndScopeIsolation": True}), flush=True)
        finally:
            agent.close()


if __name__ == "__main__":
    main()
