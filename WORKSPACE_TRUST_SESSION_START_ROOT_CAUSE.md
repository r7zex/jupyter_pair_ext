# Workspace Trust session-start root cause

Date: 2026-09-09  
Affected releases: 0.5.24 and 0.5.25

## User-visible failure

1. The user selects **Start Session** or **Join Session**.
2. Pair Notebook creates the isolated working copy and opens it.
3. VS Code enters Restricted Mode and disables Pair Notebook until the user selects **Trust this folder**.
4. After Trust, Pair Notebook returns, but the already requested Start/Join operation has been lost. The project appears as a session the user already left, and the fallback reconnect path does not reliably start the newly created session.

## Exact root cause

The 0.5.25 repair added an `onDidGrantWorkspaceTrust` continuation while leaving this manifest capability unchanged:

```json
"untrustedWorkspaces": {
  "supported": false
}
```

With `supported: false`, VS Code disables the extension in an untrusted workspace. Disabled extension code cannot retain an in-memory Start/Join claim and cannot receive `onDidGrantWorkspaceTrust`. The listener therefore cannot bridge the exact Restricted Mode interval it was intended to handle.

Start/Join persists a pending record before `vscode.openFolder()`, but 0.5.25 binds it to `vscode.env.sessionId`. The target-folder activation occurs on a new editor/extension-host lifecycle boundary. When that identifier no longer matches, `consumePendingSessionLaunch()` deletes the record and falls through to the old-session confirmation path. This record is the only distinction between a new explicit Start/Join and an unrelated stale marker, so losing it makes the two states indistinguishable again.

The suspend-watchdog readiness guard added in 0.5.25 is valid but cannot solve this failure: no ready runtime exists while Pair Notebook is disabled for Workspace Trust.

## Required state machine

1. Declare **limited** untrusted-workspace support so Pair Notebook remains loaded during Restricted Mode.
2. In Restricted Mode, do not start `SessionRuntime`, signalling, project synchronization, notebook execution, or Start/Join commands.
3. Persist a non-secret launch record before `vscode.openFolder()`, bound to the exact session, peer, folder, and stable VS Code main-process identity.
4. On target activation, validate and atomically delete that durable record immediately. Hold the validated claim only in the current extension-host memory while waiting for Trust.
5. When `onDidGrantWorkspaceTrust` fires, use that in-memory claim once and start the runtime. An unrelated marker still requires manual confirmation.
6. If VS Code closes, the extension is removed, or the extension host disappears before Trust, the in-memory claim disappears and cannot reconnect later. A new VS Code main process also cannot claim an abandoned durable record.

## Release acceptance criteria

- A real VS Code window with a clean profile must complete Start Session through the actual **Trust this folder** UI and reach an active host runtime without a reconnect prompt.
- The same flow must work for Join after snapshot bootstrap.
- While untrusted, the extension remains visible but creates no runtime/network route and refuses new Start/Join commands.
- Closing/restarting VS Code before or after Trust cannot turn an abandoned marker into automatic reconnect permission.
- Startup/trust delays cannot trigger the suspend watchdog.
- Full TypeScript, ESLint, unit/integration, real Extension Host, Python bridge, production audit, VSIX, and complete ZIP gates must pass.
