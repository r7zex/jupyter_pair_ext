"""Real subprocess and agent recovery checks; no CUDA hardware is claimed here."""
import argparse
import importlib.util
import json
import os
import http.server
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
