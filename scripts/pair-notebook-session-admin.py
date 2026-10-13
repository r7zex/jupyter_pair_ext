#!/usr/bin/env python3
"""Create a server-owned session without VS Code; keep owner credentials in a private file."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Redirects are refused for credential-bearing requests.")


def endpoint(value):
    url = urllib.parse.urlsplit(value)
    if (url.username or url.password or url.query or url.fragment or url.path not in ("", "/")
            or not url.hostname or (url.scheme != "https" and not
                                    (url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1")))):
        raise ValueError("Use a verified HTTPS origin, or HTTP only on loopback.")
    return value.rstrip("/")


def private_read(filename):
    handle = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(handle, "r", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65536 or info.st_mode & 0o077:
            raise ValueError("Credentials must be a private regular file (chmod 600).")
        return stream.read()


def rpc(url, token, body):
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
        raise ValueError("Invalid credential file.")
    request = urllib.request.Request(endpoint(url) + "/v1/sessions/rpc",
                                     data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        data = response.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError("Response exceeds the administration limit.")
        return json.loads(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("create", "list", "start", "stop", "restart", "delete"))
    parser.add_argument("--url", default="http://127.0.0.1:8787")
    parser.add_argument("--public-url", help="Verified HTTPS origin saved for VS Code import when creating over loopback")
    parser.add_argument("--token-file", help="Private administrative token file for create/list only")
    parser.add_argument("--member-config", help="Private owner or delegated administrator JSON for lifecycle")
    parser.add_argument("--name", help="Session name for create")
    parser.add_argument("--output", help="New private owner JSON file for create")
    args = parser.parse_args()
    if args.action in ("create", "list"):
        if not args.token_file:
            parser.error("create/list requires --token-file")
        token = private_read(args.token_file).strip()
        if args.action == "list":
            print(json.dumps(rpc(args.url, token, {"operation": "list"}), ensure_ascii=False, indent=2))
            return
        if not args.name or not args.output:
            parser.error("create requires --name and --output")
        saved_endpoint = endpoint(args.public_url or args.url)
        if not saved_endpoint.startswith("https://"):
            parser.error("create over loopback requires --public-url https://YOUR_VPS_ADDRESS")
        # Reserve the private destination before creating the session; never overwrite credentials.
        destination = Path(args.output)
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        created = False
        try:
            password = getpass.getpass("Session password (at least 12 characters): ")
            if len(password) < 12 or password != getpass.getpass("Repeat session password: "):
                raise ValueError("Passwords must match and contain at least 12 characters.")
            membership = rpc(args.url, token, {"operation": "create", "name": args.name, "password": password})
            created = True
            membership["endpoint"] = saved_endpoint
            payload = (json.dumps(membership, ensure_ascii=False, indent=2) + "\n").encode()
            with os.fdopen(descriptor, "wb") as output:
                descriptor = -1
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            print("Session ID:", membership["sessionId"])
            print("Owner credential saved to:", destination)
            print("Import this private JSON in Pair Notebook Connect to VPS. Give participants only the address, ID and password.")
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            if not created:
                destination.unlink(missing_ok=True)
    else:
        if not args.member_config:
            parser.error("lifecycle actions require --member-config; administrative server tokens do not impersonate session owners")
        config = json.loads(private_read(args.member_config))
        result = rpc(config["endpoint"], config["token"], {"operation": "lifecycle", "sessionId": config["sessionId"], "action": args.action})
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        print("Session administration refused (HTTP %s). Check credentials, permissions and request state." % error.code, file=sys.stderr)
        sys.exit(1)
    except (ValueError, KeyError, OSError, urllib.error.URLError):
        print("Session administration failed. Check private files, HTTPS and service availability. Credentials were not printed.", file=sys.stderr)
        sys.exit(1)
