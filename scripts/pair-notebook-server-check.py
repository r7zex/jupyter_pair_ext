#!/usr/bin/env python3
"""Execute a real cell in a disposable project without exposing owner secrets."""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import time
import urllib.request
import uuid


def output_text(value: object) -> list[str]:
    if isinstance(value, dict):
        return [str(item) for key, item in value.items() if key in {"text", "text/plain"}] + [text for item in value.values() for text in output_text(item)]
    if isinstance(value, list):
        return [text for item in value for text in output_text(item)]
    return []


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--credentials", type=Path, required=True)
    args = parser.parse_args()
    admin = json.loads(args.credentials.read_text())["adminToken"]

    def rpc(operation: str, token: str, **fields: object) -> dict:
        request = urllib.request.Request(args.url + "/v1/sessions/rpc", data=json.dumps({**fields, "operation": operation}).encode(),
                                         headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request, timeout=15) as reply:
            return json.load(reply)

    owner = rpc("create", admin, name="Installer verification " + str(uuid.uuid4()), password=str(uuid.uuid4()))
    token, session = owner["token"], owner["sessionId"]
    try:
        for _ in range(60):
            view = rpc("heartbeat", token, sessionId=session)
            if any(device["id"] == "vps" and device.get("online") and device.get("ready", True) for device in view["devices"]):
                break
            time.sleep(1)
        else:
            raise RuntimeError("Isolated Jupyter worker did not become ready.")
        notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [{"id": "installation-check", "cell_type": "code", "metadata": {}, "source": "print(6 * 7)", "outputs": [], "execution_count": None}]}
        written = rpc("write", token, sessionId=session, path="installation.ipynb", expectedRevision=0, content=base64.b64encode(json.dumps(notebook).encode()).decode())
        execution = rpc("execute", token, sessionId=session, notebook="installation.ipynb", cellIndex=0, expectedRevision=written["revision"], requestId=str(uuid.uuid4()))
        for _ in range(90):
            result = rpc("execution", token, sessionId=session, executionId=execution["id"])
            if result["state"] in {"completed", "failed", "interrupted"}:
                if result["state"] != "completed" or not any(text.strip() == "42" for text in output_text(result["events"])):
                    raise RuntimeError("Real Jupyter execution did not produce 42.")
                print("PASS: isolated Jupyter cell executed and returned 42.")
                break
            time.sleep(1)
        else:
            raise RuntimeError("Real Jupyter execution timed out.")
    finally:
        try:
            released = rpc("kernel", token, sessionId=session, notebook="installation.ipynb", command="release", requestId=str(uuid.uuid4()))
            for _ in range(30):
                result = rpc("execution", token, sessionId=session, executionId=released["id"])
                if result["state"] in {"completed", "failed", "interrupted"}:
                    if result["state"] != "completed":
                        raise RuntimeError("Installer kernel could not be released.")
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Installer kernel release timed out.")
        finally:
            rpc("lifecycle", token, sessionId=session, action="delete")


if __name__ == "__main__":
    main()
