#!/usr/bin/env python3
"""Persistent outbound-only Pair Notebook compute agent. Python 3.10+, stdlib only."""
import argparse
import base64
import csv
import http.client
import json
import math
import os
from pathlib import Path
import re
import signal
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import unicodedata
import uuid

MAX_LOG = 32 * 1024 * 1024
CHUNK = 64 * 1024
ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def sync_directory(directory):
    if os.name != "nt":
        handle = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(handle)
        finally:
            os.close(handle)


def atomic_json(target, value):
    temporary = target.with_name(target.name + "." + uuid.uuid4().hex + ".tmp")
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
    sync_directory(target.parent)


def read_json(target):
    return json.loads(target.read_text(encoding="utf-8"))


def lock_file(target):
    """The OS releases this lock on crashes; a PID alone is unsafe after reuse."""
    stream = target.open("a+b")
    try:
        if os.name == "nt":
            import msvcrt
            if target.stat().st_size == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        stream.close()
        return None
    return stream


def safe_path(value):
    try:
        return isinstance(value, str) and 0 < len(value) <= 512 and not re.search(r'[\\:*?"<>|\x00-\x1f\x7f]', value) and all(
            part and len(part.encode("utf-8")) <= 255 and part not in (".", "..") and not part.endswith((".", " "))
            and not re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", unicodedata.normalize("NFKC", part), re.I)
            for part in value.split("/"))
    except UnicodeEncodeError:
        return False


def clean_environment():
    return {key: value for key, value in os.environ.items()
            if key not in ("PAIR_AGENT_TOKEN", "PAIR_VPS_CLIENT_TOKEN", "PAIR_VPS_AGENT_TOKENS")}


def stop_process(process):
    if process.poll() is not None:
        return
    if process.stdin is not None:
        # The private supervisor retains its execution lock until the whole tree
        # is stopped. Do not kill that lock owner while it is cleaning up.
        process.stdin.close()
        process.wait()
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


class WindowsJob:
    """An OS-owned process tree; closing its handle also covers supervisor crashes."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                              "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        class Accounting(ctypes.Structure):
            _fields_ = [(name, ctypes.c_longlong) for name in ("TotalUserTime", "TotalKernelTime", "ThisPeriodTotalUserTime", "ThisPeriodTotalKernelTime")] + [
                (name, wintypes.DWORD) for name in ("TotalPageFaultCount", "TotalProcesses", "ActiveProcesses", "TotalTerminatedProcesses")]

        self.ctypes, self.accounting = ctypes, Accounting
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
            "SetInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
            "QueryInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL),
            "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
            "TerminateJobObject": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.kernel, name)
            function.argtypes, function.restype = arguments, result
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def assign(self, process):
        if not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise self.ctypes.WinError(self.ctypes.get_last_error())

    def stop(self):
        if not self.kernel.TerminateJobObject(self.handle, 1):
            raise self.ctypes.WinError(self.ctypes.get_last_error())
        while True:
            accounting = self.accounting()
            if not self.kernel.QueryInformationJobObject(self.handle, 1, self.ctypes.byref(accounting), self.ctypes.sizeof(accounting), None):
                raise self.ctypes.WinError(self.ctypes.get_last_error())
            if accounting.ActiveProcesses == 0:
                return
            time.sleep(0.02)

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def training_command(directory):
    manifest = read_json(directory / "manifest.json")
    job = manifest["job"]
    return [manifest["python"], "-u", str(directory / "work" / job["entrypoint"]), *job["args"]]


def gated_training(directory):
    # On Windows the supervisor assigns this helper to a kill-on-close Job
    # Object before opening the gate. No user code can escape the assignment.
    if sys.stdin.buffer.read(1) != b"1":
        return
    process = subprocess.Popen(training_command(directory), stdin=subprocess.DEVNULL)
    atomic_json(directory / "execution.json", {"exitCode": process.wait()})


def adopt_training_descendants():
    if sys.platform != "linux":
        return False
    Path("/proc/self/stat").read_bytes()
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    # PR_SET_CHILD_SUBREAPER: orphaned DataLoader workers become our children,
    # allowing us to wait for their actual exit before releasing execution.lock.
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot supervise training descendants")
    return True


def reap_training_descendants():
    while True:
        try:
            exited = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            return
        if exited is not None:
            os.waitpid(exited.si_pid, 0)
            continue
        # A worker may have opened its own session. As a subreaper we own its
        # unreaped PID, so these live child IDs cannot be reused underneath us.
        # Repeating after each exit also reaches newly adopted grandchildren.
        for entry in Path("/proc").iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                # stat's comm field may itself contain spaces or parentheses.
                fields = (entry / "stat").read_bytes().rsplit(b") ", 1)[1].split()
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
            if int(fields[1]) == os.getpid():
                try:
                    os.kill(int(entry.name), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        time.sleep(0.02)


def supervise_job(directory):
    held_lock = lock_file(directory / "execution.lock")
    if held_lock is None:
        return
    process, tree, adopted, gate_opened = None, None, False, False
    disconnected = threading.Event()

    def watch_runner():
        try:
            # A daemon blocked in BufferedReader can abort Python at shutdown.
            os.read(sys.stdin.fileno(), 1)
        finally:
            disconnected.set()

    watcher = threading.Thread(target=watch_runner, daemon=True)
    watcher.start()
    try:
        if (directory / "result.json").exists() or (directory / "cancel").exists() or disconnected.is_set():
            atomic_json(directory / "execution.json", {"exitCode": -1})
            return
        if os.name == "nt":
            tree = WindowsJob()
            process = subprocess.Popen([sys.executable, "-I", "-S", str(Path(__file__).resolve()), "--gated-training", str(directory)],
                                       stdin=subprocess.PIPE, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
            tree.assign(process)
            if not disconnected.is_set() and not (directory / "cancel").exists():
                process.stdin.write(b"1")
                process.stdin.flush()
                gate_opened = True
            else:
                process.stdin.close()
            while process.poll() is None and not disconnected.wait(0.1):
                pass
        else:
            # Observe exit without reaping the group leader. Its PID stays
            # reserved until descendants have been killed, even on normal exit.
            if not hasattr(os, "waitid") or not hasattr(os, "WNOWAIT"):
                raise RuntimeError("This platform cannot safely supervise a process group")
            # An inherited SIGCHLD ignore handler would auto-reap children and
            # invalidate the PID reservation used during process-tree cleanup.
            signal.signal(signal.SIGCHLD, signal.SIG_DFL)
            adopted = adopt_training_descendants()
            process = subprocess.Popen(training_command(directory), stdin=subprocess.DEVNULL, start_new_session=True)
            while not disconnected.wait(0.1):
                if os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                    break
    finally:
        try:
            if process is not None:
                if process.stdin is not None:
                    process.stdin.close()
                if tree is not None:
                    # Also removes descendants left by a normally exited parent.
                    while True:
                        try:
                            tree.stop()
                            break
                        except OSError:
                            # Keep the lock while Windows has not confirmed that
                            # every process has exited; retry transient OS errors.
                            time.sleep(0.2)
                elif os.name != "nt":
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                        # Preserve the existing grace period for finally blocks. An
                        # unreaped leader anchors the group throughout cleanup.
                        if disconnected.is_set():
                            deadline = time.monotonic() + 5
                            while time.monotonic() < deadline and os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                                time.sleep(0.05)
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                exit_code = process.wait()
                if tree is not None and not gate_opened:
                    exit_code = -1
                if adopted:
                    reap_training_descendants()
                if os.name != "nt" or not (directory / "execution.json").exists():
                    atomic_json(directory / "execution.json", {"exitCode": exit_code})
        finally:
            if tree is not None:
                tree.close()
            held_lock.close()


def run_job(directory):
    """Detached runner has no network dependency and does not possess the VPS token."""
    held_lock = lock_file(directory / "run.lock")
    if held_lock is None:
        return
    if (directory / "result.json").exists():
        held_lock.close()
        return
    process, adopted = None, False
    try:
        if (directory / "cancel").exists():
            (directory / "output.log").touch(mode=0o600)
            atomic_json(directory / "result.json", {"status": "cancelled", "exitCode": -1})
            return
        manifest = read_json(directory / "manifest.json")
        job = manifest["job"]
        work = directory / "work"
        if not safe_path(job["entrypoint"]) or not job["entrypoint"].endswith(".py"):
            raise ValueError("Invalid Python entrypoint")
        for name, content in job["files"].items():
            if not safe_path(name) or not isinstance(content, str):
                raise ValueError("Invalid source snapshot")
            target = work / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open("x", encoding="utf-8", newline="") as stream:
                stream.write(content)
        env = clean_environment()
        env["PAIR_NOTEBOOK_WORKSPACE"] = manifest["workspace"]
        env["PAIR_NOTEBOOK_JOB_ID"] = job["id"]
        # Python otherwise adds only the entrypoint's directory to sys.path.
        # A notebook/script in a subdirectory must still import root modules.
        env["PYTHONPATH"] = str(work) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        cuda_device = manifest.get("cudaDevice", "" if job["device"] == "cpu" else None)
        if cuda_device is None:
            raise ValueError("Selected GPU is no longer available; restart the agent to refresh its inventory")
        env["CUDA_VISIBLE_DEVICES"] = cuda_device
        env["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
        options = {"start_new_session": True} if os.name != "nt" else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        with (directory / "output.log").open("wb") as log:
            if (directory / "cancel").exists():
                atomic_json(directory / "result.json", {"status": "cancelled", "exitCode": -1})
                return
            if sys.platform == "linux":
                # If the private supervisor itself crashes, this surviving
                # runner must adopt and stop its training tree before reporting.
                signal.signal(signal.SIGCHLD, signal.SIG_DFL)
                adopted = adopt_training_descendants()
            process = subprocess.Popen([sys.executable, "-I", "-S", str(Path(__file__).resolve()), "--supervise-job", str(directory)],
                                       cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, **options)

            drain_errors = []

            def drain_output():
                written = 0
                truncated = False
                while True:
                    data = process.stdout.read1(CHUNK)
                    if not data:
                        break
                    if written < MAX_LOG:
                        kept = data[:MAX_LOG - written]
                        log.write(kept)
                        written += len(kept)
                        log.flush()
                    elif not truncated:
                        log.write(b"\n[Pair Notebook: local output limit reached; training continues.]\n")
                        log.flush()
                        truncated = True

            def drain():
                try:
                    drain_output()
                except Exception as error:
                    drain_errors.append(error)

            reader = threading.Thread(target=drain, daemon=True)
            reader.start()
            cancelled = False
            while process.poll() is None:
                if drain_errors:
                    stop_process(process)
                    break
                if (directory / "cancel").exists():
                    cancelled = True
                    stop_process(process)
                    break
                time.sleep(0.2)
            if process.wait() != 0:
                raise RuntimeError("Training supervision failed")
            exit_code = read_json(directory / "execution.json")["exitCode"]
            cancelled = cancelled or (directory / "cancel").exists()
            reader.join(timeout=5)
            if reader.is_alive():
                raise RuntimeError("Output stream did not close")
            if drain_errors:
                raise RuntimeError("Output could not be captured") from drain_errors[0]
            log.flush()
            os.fsync(log.fileno())
        atomic_json(directory / "result.json", {"status": "cancelled" if cancelled else ("succeeded" if exit_code == 0 else "failed"),
                                               "exitCode": exit_code})
    except Exception:
        if process is not None:
            stop_process(process)
        if adopted:
            reap_training_descendants()
        with (directory / "output.log").open("ab") as log:
            log.write(b"\nPair Notebook runner failed. Check the configured Python environment and local agent storage.\n")
        atomic_json(directory / "result.json", {"status": "failed", "exitCode": -1})
    finally:
        if process is not None and process.stdin is not None:
            process.stdin.close()
        if adopted:
            reap_training_descendants()
        if process is not None and process.stdout is not None:
            process.stdout.close()
        held_lock.close()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward an Authorization header to another endpoint.


class RequestDeadline:
    """Interrupt header/body reads even when a peer keeps dripping bytes."""
    def __init__(self, timeout):
        self.ends = time.monotonic() + timeout
        self.lock = threading.Lock()
        self.socket = None
        self.expired = False
        self.timer = threading.Timer(timeout, self.expire)
        self.timer.daemon = True
        self.timer.start()

    def expire(self):
        with self.lock:
            self.expired = True
            connection = self.socket
        if connection is not None:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def track(self, connection):
        with self.lock:
            self.socket = connection
            remaining = self.ends - time.monotonic()
            expired = self.expired or remaining <= 0
        if expired:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
            raise TimeoutError("VPS request deadline exceeded")
        connection.settimeout(remaining)
        return connection

    def close(self):
        with self.lock:
            self.socket = None
        self.timer.cancel()


class DeadlineResponse:
    def __init__(self, response, deadline):
        self.response, self.deadline = response, deadline

    def __enter__(self):
        return self.response

    def __exit__(self, exception_type, *_args):
        try:
            self.response.close()
        finally:
            self.deadline.close()
        if exception_type is None and (self.deadline.expired or time.monotonic() >= self.deadline.ends):
            raise TimeoutError("VPS request deadline exceeded")


class DeadlineOpener:
    def __init__(self, *handlers, context=None):
        self.handlers = handlers
        self.context = context

    def open(self, request, timeout):
        deadline = RequestDeadline(timeout)

        class TrackConnection:
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                create = self._create_connection
                # Register before proxy CONNECT or TLS wrapping starts. HTTPS
                # replaces the plain socket, so register its SSL socket as well.
                self._create_connection = lambda *a, **kw: deadline.track(create(*a, **kw))

            def connect(self):
                super().connect()
                deadline.track(self.sock)

        class HttpConnection(TrackConnection, http.client.HTTPConnection):
            pass

        class HttpsConnection(TrackConnection, http.client.HTTPSConnection):
            pass

        class HttpHandler(urllib.request.HTTPHandler):
            def http_open(self, req):
                return self.do_open(HttpConnection, req)

        class HttpsHandler(urllib.request.HTTPSHandler):
            def https_open(self, req):
                return self.do_open(HttpsConnection, req, context=self._context)

        opener = urllib.request.build_opener(*self.handlers, NoRedirect(), HttpHandler(), HttpsHandler(context=self.context))
        try:
            return DeadlineResponse(opener.open(request, timeout=timeout), deadline)
        except Exception as error:
            deadline.expire()
            deadline.close()
            if isinstance(error, urllib.error.HTTPError):
                error.close()
            raise


class Agent:
    def __init__(self, args):
        self.args = args
        url = urllib.parse.urlsplit(args.url)
        if url.scheme not in ("http", "https") or url.username or url.password or "?" in args.url or "#" in args.url or not url.hostname:
            raise ValueError("Invalid VPS URL")
        if url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("Use HTTPS outside localhost")
        if not ID.fullmatch(args.id):
            raise ValueError("Invalid agent ID")
        self.endpoint = args.url.rstrip("/")
        self.token = Path(args.token_file).expanduser().read_text().strip() if args.token_file else os.environ.get("PAIR_AGENT_TOKEN", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", self.token):
            raise ValueError("Missing agent credential")
        interpreter = shutil.which(str(Path(args.python).expanduser()))
        if not interpreter:
            raise ValueError("The owner-selected Python interpreter does not exist")
        # Preserve a venv's interpreter symlink; resolving it loses the environment.
        self.args.python = os.path.abspath(interpreter)
        self.args.workspace = str(Path(args.workspace).expanduser().resolve())
        self.state = Path(args.state).expanduser().resolve()
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = lock_file(self.state / "agent.lock")
        if self.lock is None:
            raise ValueError("Another agent owns this state directory")
        identity_file = self.state / "identity.json"
        if not identity_file.exists():
            atomic_json(identity_file, {"agentId": args.id, "instanceId": uuid.uuid4().hex})
        identity = read_json(identity_file)
        if identity["agentId"] != args.id:
            raise ValueError("State directory belongs to a different agent ID")
        self.instance = identity["instanceId"]
        self.resources = self.inventory()
        self.opener = DeadlineOpener()
        self.active_id = None
        self.children = []
        self.recovery_started = {}

    def inventory(self):
        gpus = []
        try:
            result = subprocess.run(["nvidia-smi", "--query-gpu=index,uuid,name,memory.total", "--format=csv,noheader,nounits"],
                                    capture_output=True, text=True, timeout=5, check=True)
            for row in csv.reader(result.stdout.splitlines(), skipinitialspace=True):
                index, gpu_uuid, name, memory = [value.strip() for value in row]
                if not re.fullmatch(r"GPU-[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", gpu_uuid):
                    raise ValueError("Invalid GPU identity")
                gpus.append({"index": int(index), "uuid": gpu_uuid, "name": name, "memoryMb": float(memory)})
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
        return {"cpuCount": os.cpu_count() or 1, "python": self.args.python, "gpus": gpus}

    def request(self, action, body):
        request = urllib.request.Request(self.endpoint + "/v1/agents/" + self.args.id + "/" + action,
                                         data=json.dumps({"instanceId": self.instance, **body}).encode(),
                                         headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"},
                                         method="POST")
        with self.opener.open(request, timeout=10) as response:
            data = response.read(6 * 1024 * 1024 + 1)
            if len(data) > 6 * 1024 * 1024:
                raise ValueError("VPS response is too large")
            return json.loads(data)

    def ensure_job(self, job):
        if not ID.fullmatch(job["id"]):
            raise ValueError("Invalid job ID")
        directory = self.state / "jobs" / job["id"]
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        sync_directory(directory.parent)
        sync_directory(self.state)
        manifest = directory / "manifest.json"
        if manifest.exists():
            retained = read_json(manifest)["job"]
            for field in ("id", "agentId", "entrypoint", "device", "gpuUuid", "files", "args"):
                if field in job and job[field] != retained.get(field):
                    raise ValueError("The broker input disagrees with the retained execution receipt")
        if job.get("cancelRequested") and not (directory / "cancel").exists():
            (directory / "cancel").touch(mode=0o600)
            sync_directory(directory)
        self.recovery_started.setdefault(job["id"], time.monotonic())
        if not manifest.exists():
            gpu = None if job["device"] == "cpu" else next((gpu for gpu in self.inventory()["gpus"] if
                        (gpu["uuid"].lower() == job["gpuUuid"].lower() if job.get("gpuUuid") else "gpu:" + str(gpu["index"]) == job["device"])), None)
            atomic_json(manifest, {"job": job, "python": self.args.python,
                                   "workspace": self.args.workspace, "launchedAt": time.time(),
                                   "cudaDevice": "" if job["device"] == "cpu" else (gpu["uuid"] if gpu else None)})
            # Persist intent before spawning. On ambiguous crash recovery we never rerun Python.
            try:
                options = {"start_new_session": True} if os.name != "nt" else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
                self.children.append(subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--run-job", str(directory)],
                                                       env=clean_environment(), stdin=subprocess.DEVNULL,
                                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options))
            except OSError:
                atomic_json(directory / "result.json", {"status": "failed", "exitCode": -1})
        elif not (directory / "result.json").exists() and time.monotonic() - self.recovery_started[job["id"]] > 10:
            runner_lock = lock_file(directory / "run.lock")
            if runner_lock is not None:
                try:
                    execution_lock = lock_file(directory / "execution.lock")
                    if execution_lock is not None:
                        try:
                            if not (directory / "result.json").exists():
                                with (directory / "output.log").open("ab") as stream:
                                    stream.write(b"\nRunner was interrupted. This job will not be automatically rerun.\n")
                                atomic_json(directory / "result.json", {"status": "interrupted", "exitCode": -1})
                        finally:
                            execution_lock.close()
                finally:
                    runner_lock.close()
        return directory

    def tick(self):
        self.children = [child for child in self.children if child.poll() is None]
        response = self.request("poll", {"name": self.args.name or self.args.id, "resources": self.resources,
                                         "knownJobId": self.active_id})
        job = response["job"]
        if job is None:
            self.active_id = None
            return
        directory = self.ensure_job(job)
        self.active_id = job["id"]
        if job["cancelRequested"]:
            (directory / "cancel").touch()
        log = directory / "output.log"
        data = b""
        size = log.stat().st_size if log.exists() else 0
        if log.exists():
            with log.open("rb") as stream:
                stream.seek(job["logEnd"])
                data = stream.read(CHUNK)
        report = {"jobId": job["id"], "offset": job["logEnd"], "log": base64.b64encode(data).decode()}
        result_file = directory / "result.json"
        if result_file.exists():
            # The runner closes output before committing result.json. Re-stat after that
            # commit so a fast finish cannot acknowledge completion before its final log.
            final_size = log.stat().st_size if log.exists() else 0
            if job["logEnd"] + len(data) >= final_size:
                report["result"] = read_json(result_file)
        acknowledged = self.request("report", report)
        if acknowledged["cancelRequested"]:
            (directory / "cancel").touch()
        if "result" in report:
            self.active_id = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url")
    parser.add_argument("--id")
    parser.add_argument("--name", default="")
    parser.add_argument("--token-file")
    parser.add_argument("--state", default=str(Path.home() / ".pair-notebook-agent"))
    parser.add_argument("--workspace", default=os.getcwd(), help="Existing datasets/project directory; exposed as PAIR_NOTEBOOK_WORKSPACE")
    parser.add_argument("--python", default=sys.executable, help="Owner-selected training environment (never supplied by a job)")
    parser.add_argument("--poll-seconds", type=float, default=2)
    parser.add_argument("--run-job", help=argparse.SUPPRESS)
    parser.add_argument("--supervise-job", help=argparse.SUPPRESS)
    parser.add_argument("--gated-training", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.supervise_job:
        supervise_job(Path(args.supervise_job).resolve())
        return
    if args.gated_training:
        gated_training(Path(args.gated_training).resolve())
        return
    if args.run_job:
        run_job(Path(args.run_job).resolve())
        return
    if not args.url or not args.id or not math.isfinite(args.poll_seconds) or args.poll_seconds < 0.1:
        parser.error("--url, --id and a positive polling interval are required")
    try:
        agent = Agent(args)
    except Exception:
        print("Agent configuration failed. Check URL, credential, agent ID and writable state directory.", file=sys.stderr)
        sys.exit(1)
    print("Pair Notebook compute agent started; training runs independently of editor connections.", flush=True)
    disconnected = False
    while True:
        try:
            agent.tick()
            if disconnected:
                print("VPS connection restored.", flush=True)
            disconnected = False
        except KeyboardInterrupt:
            break
        except Exception:
            if not disconnected:
                print("VPS request failed; retrying. Existing training continues. Check connectivity, credentials and retained agent state.",
                      file=sys.stderr, flush=True)
            disconnected = True
        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    main()
