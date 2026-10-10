"""Real subprocess and agent recovery checks; no CUDA hardware is claimed here."""
import argparse
import hashlib
import importlib.util
import json
import os
import http.server
from pathlib import Path
import signal
import subprocess
import ssl
import sys
import tempfile
import threading
import time
import urllib.request
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


class Round2Stage32(unittest.TestCase):
    pass


def cancelled_bootstrap_case(mask):
    def test(self):
        with tempfile.TemporaryDirectory(prefix="pair-agent-cancel-bootstrap-") as temporary:
            root = Path(temporary)
            args = argparse.Namespace(url="http://localhost:9999", id="pc", name="PC", token_file=None,
                                      state=str(root / "state"), workspace=str(root), python=sys.executable)
            with patch.dict(os.environ, {"PAIR_AGENT_TOKEN": "a" * 32}), patch.object(agent_module.subprocess, "run", side_effect=OSError):
                owner = agent_module.Agent(args)
            try:
                directory = owner.state / "jobs" / f"cancelled-{mask}"
                directory.mkdir(parents=True)
                source = "print('must never execute')" if not mask & 2 else "# broken unicode \ud800"
                job = {"id": f"cancelled-{mask}", "agentId": "pc", "device": "gpu:7" if mask & 1 else "cpu",
                       "entrypoint": "../train.py" if mask & 4 else "train.py", "args": [], "files": {"train.py": source}, "cancelRequested": True}
                if mask & 8:
                    (directory / "work").mkdir()
                    (directory / "work" / "train.py").write_text("original receipt", encoding="utf-8")
                if mask & 16:
                    agent_module.atomic_json(directory / "manifest.json", {"job": job, "python": sys.executable,
                                             "workspace": temporary, "cudaDevice": None if mask & 1 else ""})
                # Force the runner to execute before ensure_job returns: cancellation
                # must already be durable, regardless of OS process scheduling.
                def immediate_runner(*_args, **_kwargs):
                    agent_module.run_job(directory)
                    return Mock(poll=lambda: 0)
                with patch.object(owner, "inventory", return_value={"gpus": []}), patch.object(agent_module.subprocess, "Popen", side_effect=immediate_runner):
                    owner.ensure_job(job)
                if mask & 16:
                    agent_module.run_job(directory)
                self.assertEqual(agent_module.read_json(directory / "result.json"), {"status": "cancelled", "exitCode": -1})
                self.assertEqual((directory / "output.log").read_bytes(), b"")
                agent_module.run_job(directory)
                self.assertEqual(agent_module.read_json(directory / "result.json")["status"], "cancelled")
            finally:
                owner.lock.close()
    return test


for case in range(32):
    setattr(Round2Stage32, f"test_case_{case:02d}", cancelled_bootstrap_case(case))


class Round2Stage4(unittest.TestCase):
    pass


def deadline_case(mask):
    def test(self):
        class DripHandler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                body = b'{"job": null}'
                headers = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n"
                try:
                    if mask & 1:
                        for byte in headers:
                            self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(0.02)
                    else:
                        self.wfile.write(headers); self.wfile.flush()
                    for byte in body:
                        self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(0.02)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), DripHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            owner = agent_module.Agent.__new__(agent_module.Agent)
            owner.endpoint = "http://compute.invalid" if mask & 2 else f"http://127.0.0.1:{server.server_port}"
            owner.args = argparse.Namespace(id="pc"); owner.instance = "installation"; owner.token = "a" * 32
            proxy = urllib.request.ProxyHandler({"http": f"http://127.0.0.1:{server.server_port}"} if mask & 2 else {})
            base = agent_module.DeadlineOpener(proxy) if hasattr(agent_module, "DeadlineOpener") else urllib.request.build_opener(proxy, agent_module.NoRedirect())
            class ShortTimeout:
                def open(self, request, timeout):
                    return base.open(request, timeout=0.12)
            owner.opener = ShortTimeout()
            started = time.monotonic()
            with self.assertRaises(Exception):
                owner.request("poll", {})
            self.assertLess(time.monotonic() - started, 0.45, "Dripping bytes must not extend the total request deadline")
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)
    return test


for case in range(4):
    setattr(Round2Stage4, f"test_case_{case:02d}", deadline_case(case))


class Round2Stage2(unittest.TestCase):
    def tls_case(self, redirect):
        with tempfile.TemporaryDirectory(prefix="pair-agent-tls-") as temporary:
            root = Path(temporary); certificate = root / "certificate.pem"; key = root / "key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
                            "-out", str(certificate), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            requests = []
            class TlsHandler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_POST(self):
                    self.rfile.read(int(self.headers["Content-Length"]))
                    requests.append(self.path)
                    if redirect:
                        self.send_response(307); self.send_header("Location", "/credential-destination"); self.send_header("Content-Length", "0"); self.end_headers()
                        return
                    body = b'{"job": null}'
                    self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
                    try:
                        for byte in body:
                            self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(0.025)
                    except (OSError, ssl.SSLError):
                        pass
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), TlsHandler)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(certificate, key)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                request = urllib.request.Request(f"https://localhost:{server.server_port}/poll", data=b"{}", headers={"Authorization": "Bearer owner-test-only"})
                with self.assertRaises(Exception):
                    agent_module.DeadlineOpener(urllib.request.ProxyHandler({})).open(request, timeout=0.2)
                self.assertEqual(requests, [], "Default TLS must reject an untrusted certificate before sending credentials")
                trust = ssl.create_default_context(cafile=str(certificate))
                opener = agent_module.DeadlineOpener(urllib.request.ProxyHandler({}), context=trust)
                started = time.monotonic()
                with self.assertRaises(Exception):
                    with opener.open(request, timeout=0.12) as response:
                        json.loads(response.read())
                self.assertLess(time.monotonic() - started, 0.45)
                self.assertEqual(requests, ["/poll"], "Redirects must never forward credentials to another path")
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_trusted_tls_body_deadline_and_default_certificate_verification(self):
        self.tls_case(False)

    def test_trusted_tls_redirect_cannot_forward_credentials(self):
        self.tls_case(True)


class AgentRegressions(unittest.TestCase):
    def args(self, root, python=sys.executable):
        return argparse.Namespace(url="http://localhost:9999", id="pc", name="PC", token_file=None,
                                  state=str(root / "state"), workspace=str(root), python=python)

    def test_https_proxy_connect_headers_obey_the_total_deadline(self):
        class ConnectProxy(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_CONNECT(self):
                try:
                    for byte in b"HTTP/1.1 200 Connection established\r\n\r\n":
                        self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(0.025)
                except OSError:
                    pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ConnectProxy)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            proxy = urllib.request.ProxyHandler({"https": f"http://127.0.0.1:{server.server_port}"})
            started = time.monotonic()
            with self.assertRaises(Exception):
                agent_module.DeadlineOpener(proxy).open(urllib.request.Request("https://compute.invalid/poll", data=b"{}"), timeout=0.12)
            self.assertLess(time.monotonic() - started, 0.45)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_valid_json_without_content_length_cannot_turn_expiry_into_success(self):
        class EofResponse(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200); self.end_headers()
                try:
                    self.wfile.write(b'{"job": null}'); self.wfile.flush()
                    for _ in range(40):
                        self.wfile.write(b" "); self.wfile.flush(); time.sleep(0.025)
                except OSError:
                    pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), EofResponse)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/poll", data=b"{}")
            with self.assertRaises(TimeoutError):
                with agent_module.DeadlineOpener(urllib.request.ProxyHandler({})).open(request, timeout=0.12) as response:
                    self.assertEqual(json.loads(response.read()), {"job": None})
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

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

    def test_workspace_and_pythonpath_use_only_the_retained_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="pair-agent-isolation-") as temporary:
            root = Path(temporary)
            host = root / "owner"
            host.mkdir()
            (host / "config.txt").write_text("mutable owner config")
            source = ("import json, os\nfrom pathlib import Path\n"
                      "print(json.dumps({'cwd': str(Path.cwd()), 'workspace': os.environ['PAIR_NOTEBOOK_WORKSPACE'], "
                      "'pythonpath': os.environ['PYTHONPATH'], 'config': "
                      "(Path(os.environ['PAIR_NOTEBOOK_WORKSPACE']) / 'config.txt').read_text()}))\n")
            job = {"id": "isolated", "device": "cpu", "entrypoint": "nested/train.py", "args": [],
                   "files": {"nested/train.py": source, "config.txt": "retained config"}}
            directory = root / "job"
            directory.mkdir()
            agent_module.atomic_json(directory / "manifest.json", {"job": job, "python": sys.executable, "workspace": str(host)})
            with patch.dict(os.environ, {"PYTHONPATH": str(host)}):
                agent_module.run_job(directory)
            output = json.loads((directory / "output.log").read_text())
            self.assertEqual(output, {"cwd": str(directory / "work"), "workspace": str(directory / "work"),
                                      "pythonpath": str(directory / "work"), "config": "retained config"})

    def test_natural_completion_is_not_relabelled_by_a_late_cancel(self):
        with tempfile.TemporaryDirectory(prefix="pair-agent-finish-race-") as temporary:
            root = Path(temporary)
            with patch.dict(os.environ, {"PAIR_AGENT_TOKEN": "a" * 32}), patch.object(agent_module.Agent, "inventory", return_value={"gpus": []}):
                owner = agent_module.Agent(self.args(root))
            try:
                directory = owner.ensure_job({"id": "finish-race", "device": "cpu", "entrypoint": "train.py", "args": [],
                                              "files": {"train.py": "print('finished', flush=True)"}, "cancelRequested": False})
                deadline = time.monotonic() + 5
                while not (directory / "execution.json").exists():
                    self.assertLess(time.monotonic(), deadline, "Execution did not complete")
                    time.sleep(0.001)
                (directory / "cancel").touch()
                owner.children[0].wait(timeout=5)
                self.assertEqual(agent_module.read_json(directory / "result.json")["status"], "succeeded")
            finally:
                for child in owner.children:
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=5)
                owner.lock.close()


class ProcessTreeRegressions(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pair-agent-process-tree-")
        self.root = Path(self.temporary.name)
        args = argparse.Namespace(url="http://localhost:9999", id="pc", name="PC", token_file=None,
                                  state=str(self.root / "state"), workspace=str(self.root), python=sys.executable)
        with patch.dict(os.environ, {"PAIR_AGENT_TOKEN": "a" * 32}), patch.object(agent_module.subprocess, "run", side_effect=OSError):
            self.owner = agent_module.Agent(args)
        self.pids = []

    def running(self, pid):
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(0x100000, False, pid)  # SYNCHRONIZE
            if not handle:
                return False
            try:
                return kernel.WaitForSingleObject(handle, 0) == 258  # WAIT_TIMEOUT
            finally:
                kernel.CloseHandle(handle)
        try:
            os.kill(pid, 0)
            status = Path(f"/proc/{pid}/stat")
            return not status.exists() or status.read_text().split(") ", 1)[1].split()[0] != "Z"
        except ProcessLookupError:
            return False

    def tearDown(self):
        for child in self.owner.children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=10)
        # Failure cleanup also handles the original orphan regression, so the
        # audit cannot leave background workers mutating owner files.
        for pid in self.pids:
            if self.running(pid):
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, check=False)
                else:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        self.owner.lock.close()
        self.temporary.cleanup()

    def wait_for(self, condition, message):
        deadline = time.monotonic() + 10
        while not condition():
            if time.monotonic() > deadline:
                self.fail(message)
            time.sleep(0.02)

    def start_training_tree(self, exit_code=None, separate_session=False, redirected=False, cooperative=False):
        worker = ("import os, signal, time\nfrom pathlib import Path\n"
                  "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                  "root = Path(os.environ['PAIR_NOTEBOOK_WORKSPACE'])\n"
                  "(root / 'worker.pid').write_text(str(os.getpid()))\n"
                  "print('DataLoader worker started', flush=True)\n"
                  "while True:\n"
                  " with (root / 'worker.heartbeat').open('ab') as stream: stream.write(b'x')\n"
                  " time.sleep(0.01)\n")
        if cooperative:
            worker = worker.replace("import os, signal, time", "import os, signal, sys, time").replace(
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
                "signal.signal(signal.SIGTERM, lambda *_: (time.sleep(0.2), "
                "(Path(os.environ['PAIR_NOTEBOOK_WORKSPACE']) / 'worker-graceful.txt').write_text('cleaned'), sys.exit(0)))")
        source = ("import os, signal, subprocess, sys, time\nfrom pathlib import Path\n"
                  "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                  "root = Path(os.environ['PAIR_NOTEBOOK_WORKSPACE'])\n"
                  "(root / 'training.pid').write_text(str(os.getpid()))\n"
                  "subprocess.Popen([sys.executable, '-u', '-c', " + repr(worker) + f"], start_new_session={separate_session!r}, "
                  f"stdout={'subprocess.DEVNULL' if redirected else 'None'}, stderr={'subprocess.DEVNULL' if redirected else 'None'})\n"
                  "while not (root / 'finish').exists():\n"
                  " with (root / 'training.heartbeat').open('ab') as stream: stream.write(b'x')\n"
                  " time.sleep(0.01)\n"
                  f"sys.exit({0 if exit_code is None else exit_code})\n")
        self.job = {"id": "process-tree", "agentId": "pc", "device": "cpu", "entrypoint": "train.py",
                    "args": [], "files": {"train.py": source}, "cancelRequested": False}
        self.directory = self.owner.ensure_job(self.job)
        self.root = self.directory / "work"
        self.runner = self.owner.children[0]
        self.wait_for(lambda: all((self.root / name).exists() for name in ("training.pid", "worker.pid", "training.heartbeat", "worker.heartbeat")),
                      "Training and DataLoader worker did not start")
        self.pids = [int((self.root / name).read_text()) for name in ("training.pid", "worker.pid")]
        self.assertTrue(all(self.running(pid) for pid in self.pids))

    def assert_tree_stopped(self):
        self.assertFalse(any(self.running(pid) for pid in self.pids), "Completion must wait for training and its DataLoader worker")
        sizes = [(self.root / name).stat().st_size for name in ("training.heartbeat", "worker.heartbeat")]
        time.sleep(0.15)
        self.assertEqual(sizes, [(self.root / name).stat().st_size for name in ("training.heartbeat", "worker.heartbeat")])

    def crashed_runner(self, terminate, separate_session=False):
        self.start_training_tree(separate_session=separate_session)
        self.runner.terminate() if terminate else self.runner.kill()
        self.runner.wait(timeout=5)
        self.owner.recovery_started[self.job["id"]] = time.monotonic() - 11

        def recovered():
            self.owner.ensure_job(self.job)
            return (self.directory / "result.json").exists()

        with patch.object(agent_module.subprocess, "Popen") as replay:
            self.wait_for(recovered, "Crash cleanup did not release its execution lock")
            self.owner.ensure_job({**self.job, "cancelRequested": True})
            replay.assert_not_called()
        self.assertEqual(agent_module.read_json(self.directory / "result.json"), {"status": "interrupted", "exitCode": -1})
        self.assert_tree_stopped()

    def test_runner_kill_stops_training_and_dataloader_before_recovery(self):
        self.crashed_runner(False)

    def test_runner_terminate_stops_training_and_dataloader_before_recovery(self):
        self.crashed_runner(True)

    def test_runner_kill_stops_a_worker_that_created_its_own_session(self):
        if sys.platform != "linux" and os.name != "nt":
            self.skipTest("Requires Linux subreaper or Windows Job Object containment")
        self.crashed_runner(False, separate_session=True)

    def crashed_supervisor(self, separate_session):
        if sys.platform != "linux":
            self.skipTest("Requires Linux runner subreaper and /proc ownership lookup")
        self.start_training_tree(separate_session=separate_session)
        fields = Path(f"/proc/{self.pids[0]}/stat").read_bytes().rsplit(b") ", 1)[1].split()
        supervisor = int(fields[1])
        self.assertNotEqual(supervisor, self.runner.pid)
        os.kill(supervisor, signal.SIGKILL)
        # Observe the publication boundary first: a broker can see result.json
        # while the runner is still alive, including a blocked output close.
        self.wait_for(lambda: (self.directory / "result.json").exists(), "Supervisor crash cleanup did not finish")
        self.assertEqual(agent_module.read_json(self.directory / "result.json"), {"status": "failed", "exitCode": -1})
        self.assert_tree_stopped()
        self.runner.wait(timeout=10)

    def test_supervisor_kill_stops_training_and_dataloader_before_failed_result(self):
        self.crashed_supervisor(False)

    def test_supervisor_kill_stops_a_worker_that_created_its_own_session(self):
        self.crashed_supervisor(True)

    def test_cancellation_stops_training_and_dataloader_before_result(self):
        self.start_training_tree()
        self.owner.ensure_job({**self.job, "cancelRequested": True})
        self.runner.wait(timeout=10)
        self.assertEqual(agent_module.read_json(self.directory / "result.json")["status"], "cancelled")
        self.assert_tree_stopped()

    def test_cancellation_stops_redirected_separate_session_workers_and_preserves_unrelated_process(self):
        if sys.platform != "linux" and os.name != "nt":
            self.skipTest("Requires Linux subreaper or Windows Job Object containment")
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.start_training_tree(separate_session=True, redirected=True)
            self.owner.ensure_job({**self.job, "cancelRequested": True})
            self.runner.wait(timeout=10)
            self.assertEqual(agent_module.read_json(self.directory / "result.json")["status"], "cancelled")
            self.assert_tree_stopped()
            self.assertIsNone(unrelated.poll(), "An unrelated Python process must survive session cancellation")
        finally:
            unrelated.terminate()
            unrelated.wait(timeout=5)

    def test_poller_restart_retains_the_training_tree_without_replaying(self):
        self.start_training_tree()
        self.owner.lock.close()
        args = argparse.Namespace(url="http://localhost:9999", id="pc", name="PC", token_file=None,
                                  state=str(Path(self.temporary.name) / "state"), workspace=self.temporary.name, python=sys.executable)
        with patch.dict(os.environ, {"PAIR_AGENT_TOKEN": "a" * 32}), patch.object(agent_module.Agent, "inventory", return_value={"gpus": []}):
            replacement = agent_module.Agent(args)
        replacement.children = self.owner.children
        self.owner = replacement
        with patch.object(agent_module.subprocess, "Popen") as replay:
            self.owner.ensure_job(self.job)
            replay.assert_not_called()
        self.assertTrue(all(self.running(pid) for pid in self.pids))
        self.owner.ensure_job({**self.job, "cancelRequested": True})
        self.runner.wait(timeout=10)
        self.assert_tree_stopped()

    def test_separate_session_worker_gets_a_graceful_cleanup_before_escalation(self):
        if sys.platform != "linux":
            self.skipTest("Linux pidfd descendant signaling is verified separately from Windows Job Objects")
        self.start_training_tree(separate_session=True, redirected=True, cooperative=True)
        self.owner.ensure_job({**self.job, "cancelRequested": True})
        self.runner.wait(timeout=10)
        self.assertEqual((self.root / "worker-graceful.txt").read_text(), "cleaned")
        self.assertEqual(agent_module.read_json(self.directory / "result.json")["status"], "cancelled")
        self.assert_tree_stopped()

    def complete_training(self, exit_code):
        self.start_training_tree(exit_code)
        (self.root / "finish").touch()
        self.runner.wait(timeout=10)
        self.assertEqual(agent_module.read_json(self.directory / "result.json"),
                         {"status": "succeeded" if exit_code == 0 else "failed", "exitCode": exit_code})
        self.assert_tree_stopped()

    def test_success_stops_surviving_dataloader_and_preserves_exit_code(self):
        self.complete_training(0)

    def test_failure_stops_surviving_dataloader_and_preserves_exit_code(self):
        self.complete_training(3)

    def test_inherited_sigchld_ignore_cannot_reap_the_group_leader_early(self):
        if os.name == "nt":
            self.skipTest("SIGCHLD is a POSIX signal")
        spawn = subprocess.Popen

        def ignore_sigchld(*args, **kwargs):
            kwargs["preexec_fn"] = lambda: signal.signal(signal.SIGCHLD, signal.SIG_IGN)
            return spawn(*args, **kwargs)

        with patch.object(agent_module.subprocess, "Popen", side_effect=ignore_sigchld):
            self.start_training_tree(3)
        (self.root / "finish").touch()
        self.runner.wait(timeout=10)
        self.assertEqual(agent_module.read_json(self.directory / "result.json"), {"status": "failed", "exitCode": 3})
        self.assert_tree_stopped()

    def test_success_stops_a_worker_that_created_its_own_session(self):
        if sys.platform != "linux" and os.name != "nt":
            self.skipTest("Requires Linux subreaper or Windows Job Object containment")
        self.start_training_tree(0, separate_session=True)
        (self.root / "finish").touch()
        self.runner.wait(timeout=10)
        self.assertEqual(agent_module.read_json(self.directory / "result.json"), {"status": "succeeded", "exitCode": 0})
        self.assert_tree_stopped()

    def test_recovery_waits_for_execution_lock_without_replaying_intent(self):
        directory = self.owner.state / "jobs" / "locked"
        directory.mkdir(parents=True)
        job = {"id": "locked"}
        agent_module.atomic_json(directory / "manifest.json", {"job": job})
        self.owner.recovery_started[job["id"]] = time.monotonic() - 11
        held = agent_module.lock_file(directory / "execution.lock")
        self.assertIsNotNone(held)
        try:
            with patch.object(agent_module.subprocess, "Popen") as replay:
                self.owner.ensure_job(job)
                self.owner.ensure_job(job)
                replay.assert_not_called()
            self.assertFalse((directory / "result.json").exists())
        finally:
            held.close()
        with patch.object(agent_module.subprocess, "Popen") as replay:
            self.owner.ensure_job(job)
            self.owner.ensure_job(job)
            replay.assert_not_called()
        self.assertEqual(agent_module.read_json(directory / "result.json")["status"], "interrupted")


class PreparedDataRegressions(unittest.TestCase):
    def manifest(self, root, payload=b"\x00\xff owner binary data \x80", name="данные с пробелом/sample.bin"):
        source = root / name
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(payload)
        return {"version": "owner-data-v1", "files": [{"path": name, "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}]}

    def launch(self, root, data, files=None, declared=True):
        directory = root / "run"
        directory.mkdir()
        identity = agent_module.dataset_identity(agent_module.data_manifest(data))
        job = {"id": "prepared-data", "device": "cpu", "entrypoint": "nested/train.py", "args": [],
               "files": files or {"nested/train.py": "print('started')"}}
        if declared:
            job["dataset"] = {"version": identity["version"], "sha256": identity["sha256"]}
        agent_module.atomic_json(directory / "manifest.json", {"job": job, "python": sys.executable,
                                 "workspace": str(root / "owner"), "dataManifest": data})
        agent_module.run_job(directory)
        return directory

    def test_binary_unicode_relative_paths_are_copied_and_owner_private_files_preserved(self):
        with tempfile.TemporaryDirectory(prefix="pair-data-") as temporary:
            root = Path(temporary)
            owner = root / "owner"
            data = self.manifest(owner)
            (owner / ".env").write_text("OWNER_SECRET=must remain private")
            name = data["files"][0]["path"]
            source = ("import hashlib, json, os\nfrom pathlib import Path\n"
                      "data = Path(" + repr(name) + ").read_bytes()\n"
                      "print(json.dumps({'sha256': hashlib.sha256(data).hexdigest(), 'version': os.environ['PAIR_NOTEBOOK_DATA_VERSION']}))\n")
            directory = self.launch(root, data, {"nested/train.py": source})
            self.assertEqual(agent_module.read_json(directory / "result.json")["status"], "succeeded")
            output = json.loads((directory / "output.log").read_text())
            self.assertEqual(output, {"sha256": data["files"][0]["sha256"], "version": "owner-data-v1"})
            self.assertEqual((directory / "work" / name).read_bytes(), (owner / name).read_bytes())
            self.assertTrue((owner / ".env").exists())
            self.assertFalse((directory / "work" / ".env").exists())
            self.assertEqual(agent_module.read_json(directory / "input-identity.json")["dataset"], agent_module.dataset_identity(data))

    def test_changed_data_and_undeclared_identity_fail_before_python(self):
        for mutation in ("changed", "missing", "undeclared", "collision"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory(prefix="pair-data-reject-") as temporary:
                root = Path(temporary)
                data = self.manifest(root / "owner")
                name = data["files"][0]["path"]
                files = {"nested/train.py": "raise RuntimeError('must never execute')"}
                if mutation == "changed":
                    (root / "owner" / name).write_bytes(b"x" * data["files"][0]["size"])
                elif mutation == "missing":
                    (root / "owner" / name).unlink()
                elif mutation == "collision":
                    files[name] = "source attempting to replace binary data"
                directory = self.launch(root, data, files, declared=mutation != "undeclared")
                result = agent_module.read_json(directory / "result.json")
                self.assertEqual(result["status"], "failed")
                self.assertIn("reason", result)
                self.assertFalse((directory / "execution.json").exists())
                self.assertNotIn("must never execute", (directory / "output.log").read_text())

    def test_symlinks_inside_workspace_are_verified_and_external_symlinks_rejected(self):
        if os.name == "nt":
            self.skipTest("Symlink creation depends on Windows developer mode")
        for external in (False, True):
            with self.subTest(external=external), tempfile.TemporaryDirectory(prefix="pair-data-symlink-") as temporary:
                root = Path(temporary)
                data = self.manifest(root / "owner")
                name = data["files"][0]["path"]
                original = root / "owner" / name
                payload = original.read_bytes()
                target = (root if external else root / "owner") / "target.bin"
                target.write_bytes(payload)
                original.unlink()
                original.symlink_to(target)
                directory = self.launch(root, data)
                result = agent_module.read_json(directory / "result.json")
                self.assertEqual(result["status"], "failed" if external else "succeeded")
                if external:
                    self.assertIn("outside", result["reason"])

    def test_streaming_copy_resumes_a_cancelled_partial_and_checks_the_retained_prefix(self):
        with tempfile.TemporaryDirectory(prefix="pair-data-resume-") as temporary:
            root = Path(temporary)
            data = self.manifest(root / "owner", payload=bytes(range(256)) * 16384)
            work = root / "run" / "work"
            work.mkdir(parents=True)
            checks = 0
            def cancel():
                nonlocal checks
                checks += 1
                return checks >= 4
            with self.assertRaises(agent_module.PreparationCancelled):
                agent_module.copy_verified_data(root / "owner", work, data, cancel)
            target = work / data["files"][0]["path"]
            self.assertFalse(target.exists())
            staging = next(work.parent.glob("data-staging-*"))
            partial = next(staging.iterdir())
            self.assertGreater(partial.stat().st_size, 0)
            self.assertLess(partial.stat().st_size, data["files"][0]["size"])
            agent_module.copy_verified_data(root / "owner", work, data, lambda: False)
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), data["files"][0]["sha256"])
            self.assertFalse(partial.exists())
            target.unlink()
            partial.write_bytes(b"wrong prefix")
            with self.assertRaises(agent_module.PreparationError):
                agent_module.copy_verified_data(root / "owner", work, data, lambda: False)
            self.assertFalse(target.exists())

    def test_staging_cli_retries_without_running_python_and_preserves_existing_files(self):
        with tempfile.TemporaryDirectory(prefix="pair-data-cli-") as temporary:
            root = Path(temporary)
            data = self.manifest(root / "owner", payload=bytes(range(256)) * 1024)
            manifest = root / "manifest.json"
            agent_module.atomic_json(manifest, data)
            destination = root / "staged"
            destination.mkdir()
            (destination / ".env").write_text("private destination settings")
            command = [sys.executable, agent_module.__file__, "--workspace", str(root / "owner"), "--data-manifest", str(manifest),
                       "--stage-data", str(destination)]
            first = subprocess.run(command, capture_output=True, text=True, timeout=5)
            self.assertEqual(first.returncode, 0, first.stderr)
            second = subprocess.run(command, capture_output=True, text=True, timeout=5)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(first.stdout, second.stdout)
            self.assertEqual(json.loads(first.stdout), agent_module.dataset_identity(data))
            self.assertEqual((destination / ".env").read_text(), "private destination settings")
            self.assertEqual(agent_module.read_json(destination / "owner-data-manifest.json"), data)
            self.assertFalse((destination / "execution.json").exists())

    def test_source_changes_after_preparation_do_not_change_the_running_dataset(self):
        with tempfile.TemporaryDirectory(prefix="pair-data-immutable-") as temporary:
            root = Path(temporary)
            data = self.manifest(root / "owner")
            name = data["files"][0]["path"]
            source = ("from pathlib import Path\nimport hashlib\n"
                      "Path(" + repr(str(root / "owner" / name)) + ").write_bytes(b'owner dataset changed after preparation')\n"
                      "print(hashlib.sha256(Path(" + repr(name) + ").read_bytes()).hexdigest())\n")
            directory = self.launch(root, data, {"nested/train.py": source})
            self.assertEqual(agent_module.read_json(directory / "result.json")["status"], "succeeded")
            self.assertEqual((directory / "output.log").read_text().strip(), data["files"][0]["sha256"])
            self.assertNotEqual((directory / "work" / name).read_bytes(), (root / "owner" / name).read_bytes())

    def test_staging_does_not_follow_a_destination_directory_symlink(self):
        if os.name == "nt":
            self.skipTest("Symlink creation depends on Windows developer mode")
        with tempfile.TemporaryDirectory(prefix="pair-data-target-symlink-") as temporary:
            root = Path(temporary)
            data = self.manifest(root / "owner", name="data/sample.bin")
            outside = root / "private"
            outside.mkdir()
            work = root / "run" / "work"
            work.mkdir(parents=True)
            (work / "data").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(agent_module.PreparationError):
                agent_module.copy_verified_data(root / "owner", work, data, lambda: False)
            self.assertFalse((outside / "sample.bin").exists())


if __name__ == "__main__":
    unittest.main()
