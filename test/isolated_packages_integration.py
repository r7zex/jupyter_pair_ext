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
        config = argparse.Namespace(id="pc", session="acceptance", url="http://127.0.0.1:1", token_file=None,
                                    python=args.python, bridge=str(args.root / "media/jupyter_kernel_bridge.py"),
                                    state=str(state), name="Isolated acceptance", share=True, max_kernels=1)
        agent = module.SessionAgent(config, transport=BrokerBoundary(), sandbox=sandbox)
        sequence = 0
        def execute(code, command="execute", generation=1):
            nonlocal sequence
            sequence += 1
            identifier = f"run-{sequence}"
            request = {"id": identifier, "executionId": identifier, "sessionId": "acceptance", "kernelId": "acceptance:notebook",
                       "generation": generation, "deviceId": "pc", "scope": "public", "files": [],
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
            result = execute("%pip install numpy")
            if args.baseline:
                return
            assert result["state"] == "completed", result.get("error")
            result = execute("import numpy as np; print(np.arange(10)); marker = 42")
            assert result["state"] == "completed"
            assert "0 1 2 3 4 5 6 7 8 9" in json.dumps(result["events"])
            assert execute("", "restart", 2)["state"] == "completed"
            result = execute("import numpy as np; print(np.arange(10)); print('marker' in globals())", generation=2)
            assert result["state"] == "completed"
            assert "False" in json.dumps(result["events"])
            result = execute("%pip install pair-notebook-nonexistent-package-acceptance-0611", generation=2)
            assert result["state"] == "failed"
            assert execute("import numpy as np; print(np.arange(3))", generation=2)["state"] == "completed"
            print(json.dumps({"result": "passed", "nonRoot": True, "network": "offline kernel; wheel downloader only", "restartPreservedPackages": True}), flush=True)
        finally:
            agent.close()


if __name__ == "__main__":
    main()
