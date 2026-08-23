"""Small stdio <-> Jupyter messaging bridge used by Pair Notebook.

The selected Python environment owns both jupyter_client and ipykernel. JSON
lines on stdout are exclusively protocol messages; the kernel itself is
connected through ZeroMQ and never writes into this stream.
"""

from __future__ import annotations

import base64
import json
import math
import os
import subprocess
import sys
import threading
import time
import traceback
from queue import Empty
from typing import Any


WRITE_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
STOP = threading.Event()
PAUSE_CHANNELS = threading.Event()
PENDING: dict[str, dict[str, Any]] = {}
AUXILIARY: dict[str, tuple[str, str]] = {}
MAX_SERIALIZED_CHARACTERS = 400_000
MAX_COLLECTION_ITEMS = 256
MAX_SERIALIZATION_DEPTH = 20
MAX_EMIT_BYTES = 512 * 1024
MAX_KERNEL_BUFFERS = 64
MAX_KERNEL_BUFFER_BYTES = 256 * 1024
MAX_PENDING_EXECUTIONS = 128
MAX_PENDING_AUXILIARY = 128
MAX_REQUEST_ID_CHARACTERS = 256
MAX_CODE_BYTES = 32 * 1024 * 1024
MAX_COMMAND_BYTES = 48 * 1024 * 1024
MAX_INPUT_CHARACTERS = 64 * 1024
BASE64_MIME_TYPES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
    "image/avif",
    "image/x-icon",
}


def emit(message: dict[str, Any]) -> None:
    encoded = json.dumps(message, ensure_ascii=True, separators=(",", ":"))
    if len(encoded) > MAX_EMIT_BYTES:
        request_id = str(message.get("requestId", ""))[:256]
        if message.get("type") == "complete":
            message = {
                "type": "complete",
                "requestId": request_id,
                "success": False,
                "content": {
                    "status": "error",
                    "ename": "OutputTooLarge",
                    "evalue": "Jupyter output exceeded the Pair Notebook safety limit.",
                },
            }
        elif message.get("type") == "fatal":
            message = {
                "type": "fatal",
                "message": "Jupyter bridge diagnostic exceeded the Pair Notebook safety limit.",
            }
        else:
            message = {
                "type": "channelError",
                "requestId": request_id,
                "channel": "output",
                "message": "Jupyter output exceeded the Pair Notebook safety limit and was omitted.",
            }
        encoded = json.dumps(message, ensure_ascii=True, separators=(",", ":"))
    with WRITE_LOCK:
        print(encoded, flush=True)


def serializable(value: Any, budget: list[int] | None = None, depth: int = 0) -> Any:
    if budget is None:
        budget = [MAX_SERIALIZED_CHARACTERS]
    if budget[0] <= 0 or depth >= MAX_SERIALIZATION_DEPTH:
        return "[Pair Notebook output truncated]"
    if isinstance(value, bytes):
        maximum_bytes = min(len(value), max(0, budget[0] * 3 // 4))
        encoded = base64.b64encode(value[:maximum_bytes]).decode("ascii")
        budget[0] -= len(encoded)
        if maximum_bytes != len(value):
            return {"__pairNotebookOmittedBytes": len(value)}
        return {"__pairNotebookBytesBase64": encoded}
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        omitted_base64_mimes: list[str] = []
        for index, (key, item) in enumerate(value.items()):
            if index >= MAX_COLLECTION_ITEMS or budget[0] <= 0:
                result["__pairNotebookTruncated"] = True
                break
            safe_key = str(key)[:1024]
            budget[0] -= len(safe_key)
            if safe_key.lower() in BASE64_MIME_TYPES:
                encoded = bounded_base64_mime(item, budget[0])
                if encoded is None:
                    omitted_base64_mimes.append(safe_key)
                    continue
                budget[0] -= len(encoded)
                result[safe_key] = encoded
                continue
            result[safe_key] = serializable(item, budget, depth + 1)
        if omitted_base64_mimes:
            notice = (
                "[Pair Notebook] Oversized or invalid binary output was omitted: "
                + ", ".join(omitted_base64_mimes)
            )
            if len(notice) <= budget[0]:
                existing = result.get("text/plain")
                if isinstance(existing, str):
                    result["text/plain"] = f"{existing}\n{notice}"
                elif isinstance(existing, list):
                    existing.append(f"\n{notice}")
                else:
                    result["text/plain"] = notice
                budget[0] -= len(notice)
        return result
    if isinstance(value, (list, tuple)):
        result = [serializable(item, budget, depth + 1)
                  for item in value[:MAX_COLLECTION_ITEMS] if budget[0] > 0]
        if len(value) > MAX_COLLECTION_ITEMS:
            result.append("[Pair Notebook output truncated]")
        return result
    if isinstance(value, str):
        available = max(0, budget[0])
        result = value[:available]
        budget[0] -= len(result)
        if len(result) != len(value):
            result += "\n[Pair Notebook output truncated]"
        return result
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        if value.bit_length() > 4096:
            return "[Pair Notebook integer output truncated]"
        rendered = str(value)
        budget[0] -= len(rendered)
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    return serializable(str(value), budget, depth + 1)


def bounded_base64_mime(value: Any, maximum_characters: int) -> str | None:
    """Return one complete Base64 value, never a truncated/corrupted prefix."""
    if isinstance(value, str):
        parts = [value]
    elif isinstance(value, (list, tuple)) and len(value) <= MAX_COLLECTION_ITEMS:
        if not all(isinstance(part, str) for part in value):
            return None
        parts = value
    else:
        return None
    total = sum(len(part) for part in parts)
    if total > maximum_characters or total % 4 != 0:
        return None
    encoded = "".join(parts)
    try:
        base64.b64decode(encoded.encode("ascii"), validate=True)
    except (UnicodeEncodeError, ValueError):
        return None
    return encoded


def serialize_buffers(values: Any) -> list[str]:
    """Encode only a bounded number of bounded aggregate kernel buffers."""
    if not isinstance(values, (list, tuple)):
        return []
    result: list[str] = []
    remaining = MAX_KERNEL_BUFFER_BYTES
    for item in values[:MAX_KERNEL_BUFFERS]:
        try:
            view = memoryview(item).cast("B")
        except (TypeError, ValueError):
            continue
        if view.nbytes > remaining:
            break
        result.append(base64.b64encode(view).decode("ascii"))
        remaining -= view.nbytes
    return result


def decode_code(value: Any) -> str:
    if not isinstance(value, str) or len(value) > (MAX_CODE_BYTES * 4 // 3) + 4:
        raise ValueError("Execution code exceeds the Pair Notebook safety limit.")
    decoded = base64.b64decode(value.encode("ascii"), validate=True)
    if len(decoded) > MAX_CODE_BYTES:
        raise ValueError("Execution code exceeds the Pair Notebook safety limit.")
    return decoded.decode("utf-8")


def request_for(message: dict[str, Any]) -> tuple[str, str]:
    parent_id = str(message.get("parent_header", {}).get("msg_id", ""))
    with STATE_LOCK:
        pending = PENDING.get(parent_id)
        auxiliary = AUXILIARY.get(parent_id)
    if pending:
        return str(pending["requestId"]), parent_id
    if auxiliary:
        return auxiliary[0], parent_id
    return "", parent_id


def maybe_complete(jupyter_id: str) -> None:
    with STATE_LOCK:
        pending = PENDING.get(jupyter_id)
        if not pending or not pending.get("reply") or not pending.get("idle"):
            return
        PENDING.pop(jupyter_id, None)
    content = pending["reply"].get("content", {})
    emit({
        "type": "complete",
        "requestId": pending["requestId"],
        "success": content.get("status") == "ok",
        "executionCount": content.get("execution_count"),
        "content": serializable(content),
    })


def iopub_loop(client: Any, manager: Any) -> None:
    while not STOP.is_set():
        if PAUSE_CHANNELS.is_set():
            time.sleep(0.05)
            continue
        try:
            message = client.get_iopub_msg(timeout=0.2)
        except Empty:
            continue
        except BaseException as exc:
            if not STOP.is_set():
                emit({"type": "channelError", "channel": "iopub", "message": str(exc)})
            continue
        request_id, jupyter_id = request_for(message)
        message_type = str(message.get("header", {}).get("msg_type", ""))
        content = serializable(message.get("content", {}))
        buffers = serialize_buffers(message.get("buffers", []))
        if request_id:
            emit({
                "type": "iopub",
                "requestId": request_id,
                "messageType": message_type,
                "content": content,
                "metadata": serializable(message.get("metadata", {})),
                "buffersBase64": buffers,
            })
        if message_type == "status" and jupyter_id:
            execution_state = content.get("execution_state")
            deliver_interrupt = False
            with STATE_LOCK:
                pending = PENDING.get(jupyter_id)
                if pending and execution_state == "busy":
                    pending["busy"] = True
                    if pending.get("interruptRequested") and not pending.get("interruptDelivered"):
                        pending["interruptDelivered"] = True
                        deliver_interrupt = True
                elif pending and execution_state == "idle":
                    pending["busy"] = False
                    pending["idle"] = True
            if deliver_interrupt:
                manager.interrupt_kernel()
            if execution_state == "idle":
                maybe_complete(jupyter_id)


def shell_loop(client: Any) -> None:
    while not STOP.is_set():
        if PAUSE_CHANNELS.is_set():
            time.sleep(0.05)
            continue
        try:
            message = client.get_shell_msg(timeout=0.2)
        except Empty:
            continue
        except BaseException as exc:
            if not STOP.is_set():
                emit({"type": "channelError", "channel": "shell", "message": str(exc)})
            continue
        request_id, jupyter_id = request_for(message)
        message_type = str(message.get("header", {}).get("msg_type", ""))
        with STATE_LOCK:
            auxiliary = AUXILIARY.pop(jupyter_id, None)
            pending = PENDING.get(jupyter_id)
            if pending and message_type == "execute_reply":
                pending["reply"] = message
        if auxiliary:
            emit({"type": auxiliary[1], "requestId": auxiliary[0],
                  "content": serializable(message.get("content", {}))})
        elif pending and message_type == "execute_reply":
            maybe_complete(jupyter_id)
        elif request_id:
            emit({"type": "shell", "requestId": request_id, "messageType": message_type,
                  "content": serializable(message.get("content", {}))})


def stdin_loop(client: Any) -> None:
    while not STOP.is_set():
        if PAUSE_CHANNELS.is_set():
            time.sleep(0.05)
            continue
        try:
            message = client.get_stdin_msg(timeout=0.2)
        except Empty:
            continue
        except BaseException as exc:
            if not STOP.is_set():
                emit({"type": "channelError", "channel": "stdin", "message": str(exc)})
            continue
        request_id, _ = request_for(message)
        if request_id:
            emit({"type": "inputRequest", "requestId": request_id,
                  "content": serializable(message.get("content", {}))})


def fail_pending(reason: str) -> None:
    with STATE_LOCK:
        pending = list(PENDING.values())
        PENDING.clear()
        AUXILIARY.clear()
    for item in pending:
        emit({"type": "complete", "requestId": item["requestId"], "success": False,
              "content": {"status": "abort", "ename": "KernelRestarted", "evalue": reason}})


def wait_for_parent_message(
    getter: Any,
    parent_id: str,
    timeout: float,
    expected_type: str | None = None,
) -> dict[str, Any]:
    """Read until the reply correlated with *parent_id* arrives.

    Shell channels may still contain replies produced by readiness probes or
    other requests.  Jupyter correlation is defined by parent_header.msg_id,
    never by the position of a message in the channel.
    """
    deadline = time.monotonic() + timeout
    skipped: list[str] = []
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            summary = ", ".join(skipped[-5:]) if skipped else "none"
            raise TimeoutError(
                f"Timed out after {timeout:.1f}s waiting for {expected_type or 'reply'} "
                f"with parent_header.msg_id={parent_id}; skipped replies: {summary}"
            )
        try:
            message = getter(timeout=remaining)
        except Empty:
            continue
        actual_parent = str(message.get("parent_header", {}).get("msg_id", ""))
        message_type = str(message.get("header", {}).get("msg_type", ""))
        if actual_parent == parent_id and (expected_type is None or message_type == expected_type):
            return message
        skipped.append(f"{message_type or '?'}:{actual_parent or '<none>'}")


def main() -> int:
    try:
        from jupyter_client import KernelManager
    except BaseException:
        emit({
            "type": "fatal",
            "message": "The selected Python environment needs jupyter_client and ipykernel.",
            "installCommand": f'"{sys.executable}" -m pip install jupyter_client ipykernel',
            "traceback": traceback.format_exc(),
        })
        return 2

    working_directory = os.environ.get("PAIR_NOTEBOOK_CWD") or os.getcwd()
    manager = KernelManager(kernel_name="python3")
    manager.kernel_spec.argv = [sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"]
    try:
        manager.start_kernel(cwd=working_directory, env=dict(os.environ),
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        client = manager.client()
        client.start_channels()
        client.wait_for_ready(timeout=30)
        info_id = client.kernel_info()
        info = wait_for_parent_message(client.get_shell_msg, info_id, 10, "kernel_info_reply")
    except BaseException:
        emit({"type": "fatal", "message": "Jupyter kernel failed to start.",
              "traceback": traceback.format_exc()})
        try:
            manager.shutdown_kernel(now=True)
        except BaseException:
            pass
        return 3

    emit({"type": "ready", "pythonExecutable": sys.executable,
          "kernelInfo": serializable(info.get("content", {}))})
    threading.Thread(target=iopub_loop, args=(client, manager), daemon=True).start()
    for target in (shell_loop, stdin_loop):
        threading.Thread(target=target, args=(client,), daemon=True).start()

    command: dict[str, Any] = {}
    try:
        while True:
            encoded_line = sys.stdin.buffer.readline(MAX_COMMAND_BYTES + 1)
            if not encoded_line:
                break
            if len(encoded_line) > MAX_COMMAND_BYTES:
                while encoded_line and not encoded_line.endswith(b"\n"):
                    encoded_line = sys.stdin.buffer.readline(MAX_COMMAND_BYTES + 1)
                emit({"type": "commandError", "requestId": "",
                      "message": "Bridge command exceeds the Pair Notebook safety limit."})
                continue
            command = {}
            try:
                command = json.loads(encoded_line.decode("utf-8"))
                kind = str(command.get("command", ""))
                request_id = str(command.get("requestId", ""))
                if len(request_id) > MAX_REQUEST_ID_CHARACTERS:
                    raise ValueError("Request identifier exceeds the Pair Notebook safety limit.")
                if kind == "execute":
                    code = decode_code(command.get("codeBase64", ""))
                    with STATE_LOCK:
                        if len(PENDING) >= MAX_PENDING_EXECUTIONS:
                            raise RuntimeError("Too many pending kernel executions.")
                        msg_id = client.execute(code, silent=bool(command.get("silent", False)),
                                                store_history=not bool(command.get("silent", False)),
                                                allow_stdin=True, stop_on_error=False)
                        PENDING[msg_id] = {
                            "requestId": request_id,
                            "reply": None,
                            "idle": False,
                            "busy": False,
                            "interruptRequested": False,
                            "interruptDelivered": False,
                        }
                    emit({"type": "accepted", "requestId": request_id})
                elif kind == "inputReply":
                    value = str(command.get("value", ""))
                    if len(value) > MAX_INPUT_CHARACTERS:
                        raise ValueError("Kernel input exceeds the Pair Notebook safety limit.")
                    client.input(value)
                elif kind == "interrupt":
                    deliver_interrupt = False
                    with STATE_LOCK:
                        for pending in PENDING.values():
                            pending["interruptRequested"] = True
                            if pending.get("busy") and not pending.get("interruptDelivered"):
                                pending["interruptDelivered"] = True
                                deliver_interrupt = True
                    if deliver_interrupt:
                        manager.interrupt_kernel()
                    emit({"type": "commandResult", "command": "interrupt", "requestId": request_id})
                elif kind == "restart":
                    fail_pending("Kernel restarted")
                    PAUSE_CHANNELS.set()
                    try:
                        time.sleep(0.25)
                        manager.restart_kernel(now=True)
                        client.wait_for_ready(timeout=30)
                        info_id = client.kernel_info()
                        wait_for_parent_message(client.get_shell_msg, info_id, 10, "kernel_info_reply")
                    finally:
                        PAUSE_CHANNELS.clear()
                    emit({"type": "commandResult", "command": "restart", "requestId": request_id})
                elif kind == "complete":
                    with STATE_LOCK:
                        if len(AUXILIARY) >= MAX_PENDING_AUXILIARY:
                            raise RuntimeError("Too many pending kernel metadata requests.")
                        msg_id = client.complete(str(command.get("code", "")), int(command.get("cursorPos", 0)))
                        AUXILIARY[msg_id] = (request_id, "completionResult")
                elif kind == "kernelInfo":
                    with STATE_LOCK:
                        if len(AUXILIARY) >= MAX_PENDING_AUXILIARY:
                            raise RuntimeError("Too many pending kernel metadata requests.")
                        msg_id = client.kernel_info()
                        AUXILIARY[msg_id] = (request_id, "kernelInfoResult")
                elif kind == "shutdown":
                    break
                else:
                    emit({"type": "commandError", "requestId": request_id, "message": f"Unknown command: {kind}"})
            except BaseException:
                emit({"type": "commandError", "requestId": str(command.get("requestId", ""))[:MAX_REQUEST_ID_CHARACTERS],
                      "message": "Bridge command failed", "traceback": traceback.format_exc()})
    finally:
        STOP.set()
        fail_pending("Kernel stopped")
        try:
            client.stop_channels()
        finally:
            try:
                manager.shutdown_kernel(now=True)
            except BaseException:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
