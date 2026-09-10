# Pair Notebook infinite host-start connection: root-cause report

Date: 2026-09-09  
Affected release: 0.5.26  
Scope: session launch lifecycle and network-start supervision only. The protocol-v7 CRDT/editor/notebook synchronization algorithms are not involved and must not be changed for this defect.

## User-visible failure

After **Start Session** opens the isolated `project_test` workspace, Pair Notebook keeps the notification:

```text
Pair Notebook: connecting to session
```

The dashboard still offers Start/Join, but another Start is rejected because the previous workspace restore remains in progress. The user therefore cannot establish or replace the session from that window.

## Incident evidence

The installed extension is `pair-notebook.pair-notebook@0.5.26`.

The affected output log begins with:

```text
[info] Starting session b90b306e-19a3-4c3a-b30a-19be514b5756 in resilient mode.
[state:connecting] Opening peer transport.
```

It had not emitted `connected`, `ready`, or a startup error more than ten minutes later. The persisted marker still had `freshStart: true`.

The isolated project is not large: it contains four files totalling 3,639 bytes. This rules out a long project copy or project indexing operation as the explanation for this incident.

The same VS Code process repeatedly logged:

```text
Failed to establish a socket connection to proxies: PROXY 127.0.0.1:10809
```

The effective settings are:

```text
http.proxy = http://127.0.0.1:10809
http.proxySupport = override
```

A direct TCP probe of `127.0.0.1:10809` failed. Earlier Pair Notebook attempts in the same profile reached the same startup phase and then reported:

```text
Guaranteed emergency relay readiness failed: No emergency relay family became ready.
No Nostr emergency relay completed a verified data-path check.
No MQTT emergency broker completed a verified data-path check.
```

This establishes the unavailable configured proxy as the incident trigger.

## Exact code path

The target workspace activation follows this path:

```text
offerWorkspaceSessionRestore()
  -> startWorkspaceSessionRestore()
     -> restoreWorkspaceSession()
        -> runtime = new SessionRuntime(...)
        -> vscode.window.withProgress(..., () => runtime.start())
           -> SessionRuntime.start()
              -> MeshTransport.start()
                 -> public signalling and emergency-relay startup
```

`restoreWorkspaceSession()` gives the entire `runtime.start()` Promise to a non-cancellable progress notification. It supplies no outer deadline or abort signal. Cleanup, the user-facing error, and clearing `workspaceSessionRestore` occur only after that Promise resolves or rejects.

Consequently, one non-settling network-start Promise leaves all of these states latched indefinitely:

- the progress notification remains open;
- `workspaceSessionRestore` remains defined;
- the runtime remains pre-ready;
- a new Start/Join command is rejected as “still restoring”;
- the marker remains a failed fresh launch.

The internal emergency-relay checks normally intend to reject after 15 seconds, but the outer launch lifecycle assumes every nested network implementation will always honour its own deadline. The current live incident proves that assumption is false under the unavailable forced-proxy/recovery sequence. A user-visible startup operation therefore has no authoritative liveness boundary.

There is a second independent latch after the normal 15-second relay failure. The startup catch path awaits `showLocalRouteFailedMessage()`, which in turn awaits `vscode.window.showWarningMessage()`. VS Code message promises remain pending until the notification is dismissed or an action is selected. Because `workspaceSessionRestore` is cleared only by the outer `.finally()`, an unanswered failure notification keeps the restore guard set even though transport cleanup has already completed. The incident logs demonstrate this sequence: a relay-readiness failure is followed by later Start commands being rejected as “still restoring.” User acknowledgement must never own lifecycle cleanup.

## Why synchronization is not the cause

`EditorSynchronizer` is constructed only after `runtime.start()` returns. In the failing incident it never returns, so editor/notebook CRDT synchronization has not started.

The repair must not modify:

- `src/vscode/sync.ts`;
- CRDT document semantics;
- notebook cell identity or output/execution synchronization;
- protocol messages or versions.

## Required repair

The extension-level launch lifecycle must supervise the opaque runtime start operation:

1. Give startup one explicit, tested maximum duration independent of nested transport timers.
2. When the deadline expires, reject with an actionable startup-timeout error naming the likely proxy/network cause.
3. Always stop the exact pre-ready runtime and clear every extension-level startup latch in `finally`/existing failure cleanup.
4. Never turn the failed fresh launch into an active or established session.
5. Make a later explicit retry possible without restarting VS Code.
6. Guard cleanup against late settlement so a timed-out attempt cannot become ready afterward.
7. Present failure/retry UI out of band so an ignored notification cannot retain `workspaceSessionRestore`.
8. Add deterministic tests for resolution, rejection, timeout, late resolution, and timer disposal.

This repair guarantees the bounded property that Pair Notebook will leave the **connecting** state and return control to the user even if a nested network Promise never settles. It cannot guarantee internet or proxy availability; an unreachable configured proxy must still produce a clear recoverable failure rather than a false successful session.

## Acceptance criteria

- A never-settling runtime start cannot keep the UI in `connecting` beyond the extension-owned deadline.
- Timeout cleanup runs exactly once and a subsequent explicit restore/retry is allowed.
- An unanswered startup-failure notification does not keep the restore guard set.
- A runtime that resolves after the timeout cannot be attached to the dashboard, notebook controller, presence renderer, or synchronizer.
- A normal successful start remains unchanged.
- A normal immediate startup error remains unchanged except for clearer lifecycle cleanup.
- Existing sync/CRDT/protocol tests remain green without edits to synchronization code.
