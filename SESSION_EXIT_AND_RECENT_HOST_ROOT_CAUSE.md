# Session establishment exit and Recent host-name root cause

Date: 2026-09-12

Baseline: `d9376d4911ea743747cb12576b19115c6715d42b` (`main`, package version `0.5.26`)

Affected published release: `v0.5.27` at `5a274f6754ed69631a2b65120289c858503bf383` (released from a side branch and not merged into `main`)

Status: localized before production changes

## Reported behavior

- A session that could be created on `0.5.23` can be torn down while the new working-folder window is still connecting.
- Disconnect/leave timeout behavior must apply only after the session is fully established. It must not turn Start/Join setup into a session exit.
- Recent Sessions can show the wrong host nickname for guests while the host's own entry is correct.
- Synchronization, CRDT, transport, and protocol behavior are explicitly outside the requested change.

## Scope proof

`git diff v0.5.23..v0.5.26 -- src/runtime src/core/election.ts src/core/types.ts` is empty. The runtime, mesh, election, and protocol implementation that existed in `0.5.23` did not change in the affected release range. The new behavior is in the VS Code lifecycle integration added after `0.5.23`, primarily `src/extension.ts`, `src/core/manualSessionRestore.ts`, and `src/core/recentProjects.ts`.

## RC-0: published 0.5.27 adds a terminal timeout before establishment

The `v0.5.27` release was created from `codex/session-start-lifecycle-20260909`, while GitHub `main` remained on package version `0.5.26`. Its `ddf1313` implementation adds `src/core/sessionStartup.ts` and wraps `SessionRuntime.start()` in an absolute 90-second `awaitSessionStartup()` deadline.

When that deadline expires, `restoreWorkspaceSession()` classifies the in-progress connection as failed, clears the module-level runtime, and invokes `leave()` through a separate 5-second cleanup deadline. This is a timeout-driven session exit before `lifecycleReadyRuntime` can be assigned. It therefore contradicts the required boundary directly: the timeout acts during connection rather than after a fully established session later becomes unreachable.

The `0.5.28` repair must not carry the `0.5.27` startup deadline or `src/core/sessionStartup.ts` forward. Startup remains governed by the pre-`0.5.27` connection behavior; only the established-session deactivation/suspend/host-loss policies may produce an automatic exit.

## RC-1: pre-establishment runtime is treated as an active session during deactivation

`restoreWorkspaceSession()` assigns the module-level `runtime` immediately after constructing `SessionRuntime`, before awaiting `runtime.start()` and before binding the editor synchronizer, notebook controller, presence renderer, dashboard, terminal listeners, and status updates.

`deactivate()` does not test the established-runtime boundary. It calls `leaveActiveSession()` whenever `runtime` is non-null. `leaveActiveSession()` first writes a Recent Session entry and then calls `SessionRuntime.leave()`.

The resulting sequence is:

```text
Start/Join opens the isolated folder
  -> restoreWorkspaceSession assigns runtime
  -> runtime.start is still connecting
  -> Extension Host deactivates/reloads
  -> deactivate sees runtime != undefined
  -> rememberProject records a session exit
  -> runtime.leave tears down the in-progress start
```

The suspend watchdog already has a stronger guard: it requires the same `lifecycleReadyRuntime` to have been observed on both sides of the timer gap. The graceful-deactivation path bypasses that guard. Therefore startup can still be converted into an exit even though the timer-gap path was repaired in `0.5.25`.

## RC-2: pending Start/Join attempts are written to Recent before they become sessions

Both `startSession()` and `joinSession()` call `rememberProject()` before `vscode.openFolder()` and before the target Extension Host establishes the runtime. This makes a prepared or failed launch look like a session that the user already left. The same premature entry is later overwritten again by deactivation from RC-1.

Pending Start/Join, established Active Session, and Recent Session are distinct lifecycle states. A Recent entry with `leftAt` semantics must be created only when an established session later exits or loses its established host.

## RC-3: guest host nickname is recomputed from a lossy cache

`recentHostDisplayName()` has asymmetric inputs:

- for the host, it reads `descriptor.localPeer`, which is mandatory and authoritative for the local participant;
- for a guest, it searches optional `descriptor.knownPeers` for `hostPeerId` and falls back to `Unknown host` when that mutable directory cache does not contain the host.

`rememberProject()` recomputes and overwrites `hostDisplayName` on every write. It does not preserve a previously verified Recent value and does not use the live runtime peer directory. Consequently a guest can replace a correct invite/live host nickname with a fallback when leaving, while the host cannot hit that path because its own identity is always present as `localPeer`.

## Repair invariants

1. Automatic local leave on VS Code deactivation or a detected suspend gap is allowed only for the exact runtime that completed `runtime.start()` and all outer VS Code bindings.
2. A runtime that is still preparing/connecting must never be written to Recent and must never be torn down by the established-session exit policy.
3. Start/Join preparation must not create a Recent entry. Recent is written only after an established session exits.
4. Guest Recent metadata prefers the live authenticated host nickname, then the descriptor directory, then an already stored valid nickname. A missing cache entry must not overwrite a better value with `Unknown host`.
5. Explicit Leave retains its existing credential-removal semantics. Authenticated remote End Session remains terminal.
6. No synchronization, CRDT, editor-replica, transport, mesh, election, or protocol file is changed.

## Required regression coverage

- Deactivation with a constructed/starting runtime performs no established-session leave.
- Deactivation with the exact established runtime performs one leave.
- Suspend-gap timeout remains disarmed before establishment and arms only after the same established runtime survives a normal watchdog tick.
- Start and Join source paths do not add Recent entries before the target runtime commits.
- A guest exit uses the live host nickname when available.
- A missing guest host cache preserves an existing valid Recent nickname instead of replacing it with `Unknown host`.
- Host nickname behavior remains unchanged.
