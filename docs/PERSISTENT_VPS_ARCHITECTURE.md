> Historical first-stage architecture. Current implementation and acceptance: [0.6.3](PERSISTENT_VPS_REVIEW_0.6.3.md).

# Persistent VPS sessions: implementation architecture

Base inspected: `main` at `3cc515793a4dfaa9b9a1803af60a85c64899b48b`, release 0.5.39.
The working branch is `work`; GitHub branch/release metadata was checked through
the connected GitHub API. Shell Git access failed because the environment proxy
was unavailable. The local base matches the GitHub main commit.

## Existing contracts and the required boundary

The [existing VPS service](https://github.com/r7zex/jupyter_pair_ext/blob/3cc515793a4dfaa9b9a1803af60a85c64899b48b/src/vps/server.ts)
persists background jobs and relays opaque editor traffic. It does not own the
collaborative filesystem. [Ordinary execution](https://github.com/r7zex/jupyter_pair_ext/blob/3cc515793a4dfaa9b9a1803af60a85c64899b48b/src/runtime/session.ts#L1216)
requires the current VS Code Session Host. The lifetime limit is explicitly
documented in [PERSISTENT_RESEARCH.md](https://github.com/r7zex/jupyter_pair_ext/blob/3cc515793a4dfaa9b9a1803af60a85c64899b48b/docs/PERSISTENT_RESEARCH.md).
The existing [Jupyter bridge](https://github.com/r7zex/jupyter_pair_ext/blob/3cc515793a4dfaa9b9a1803af60a85c64899b48b/media/jupyter_kernel_bridge.py)
can be reused as an actual stateful kernel engine.

## Independent server mode

- `src/vps/persistentServer.ts` owns session identity, lifecycle, password joins,
  member tokens, roles, presence, execution admission and results. It attaches
  `/v1/sessions/rpc` to `src/vps/server.ts`, preserving the existing broker and
  its single-writer data-directory lock.
- `src/vps/persistentStorage.ts` publishes revisioned project manifests and
  immutable file blobs. The server is the permanent authority. Folder ACLs are
  enforced before listing, reading, mutation and compute snapshot creation.
- `src/vps/persistentHistory.ts` reserves request/execution identities before
  dispatch and archives terminal results separately from the rolling session
  cache. Permanent receipts prevent duplicate execution after output retention
  expires; an incomplete receipt restores an interrupted state without rerun.
- `src/vps/persistentCompute.ts` separates session owner from execution target.
  Selection, explicit machine-owner consent, sharing, human presence and
  authorization are rechecked on the server. A target change advances kernel
  generation for subsequent runs without cancelling accepted work.
- `src/vps/persistentProtocol.ts` and `persistentClient.ts` define the separate
  protocol/client. Session bearer credentials cannot authorize legacy jobs or
  administrative creation. Passwords are used at join only.
- `scripts/pair-notebook-session-agent.py` owns interactive bridge processes on
  the chosen machine. A clean environment and restricted public workspace keep
  server metadata, private project files and agent tokens outside Python's
  filesystem namespace. Execution fails if isolation is unavailable.
- `scripts/pair-notebook-session-admin.py` creates/lists sessions over loopback
  without VS Code and writes a private owner JSON. The extension imports that
  credential; password joins create ordinary members. Lifecycle actions require
  an owner/delegated member credential rather than the server creation token.
- `src/vscode/persistent.ts` supplies a server-backed Explorer filesystem and a
  dedicated notebook controller. `extension.ts`, `dashboard.ts` and the command
  manifest expose create/join, lifecycle, visibility, device and consent actions.

## Delivery criteria and explicit limits

The first independently testable stage provides durable headless sessions,
password membership, server-enforced file privacy, conflict-safe synchronization
on save, compute policy and genuine stateful Jupyter execution via an independent
agent. It is a new session mode, not a background-job alias. The existing P2P
CRDT runtime remains a separate path. Per-keystroke server CRDT collaboration is
a later stage; a stale save must return a conflict and preserve the editor copy.

All execution snapshots in this stage are public-only, including owner runs.
Private notebooks cannot execute in the shared kernel. A later isolated owner
kernel must use separate snapshots, authorization and outputs before private
execution can be offered safely. Device switching creates a new namespace;
Python objects are not migrated between machines.

Session/file metadata survive a server restart. In-memory kernel objects cannot
survive a compute-machine reboot. Ambiguous accepted work must not be relaunched
silently. Retained results remain inspectable even when file source has changed.

Capacity is bounded to 16 sessions, four pending executions per session, and
32 recent execution records with 4 MiB total cached output. Older terminal
outputs move to a 128 MiB disk archive per session. Permanent receipts outlive
output pruning, so the recent-record limit does not impose a lifetime run count.
Each project permits 128 MiB, 8 MiB per file and 4096 paths. Public snapshots
permit 10 MiB of encoded JSON; RPC bodies permit 12 MiB. The Python agent also
enforces 4 MiB decoded snapshot data and 256 files, with one retained kernel in
the supplied VPS unit or two by default on an external agent. These application
limits do not cap disk use by immutable versions, receipts or dependencies.

Leaving a session or changing devices keeps accepted computation running on its
original target. Kernel release waits behind accepted work and clears only the
selected notebook namespace. Deleting the session removes server authority and
results; accepted agent work finishes locally and its idle kernel is reclaimed,
while subsequent result publication is refused.

Readiness requires TypeScript build/lint, persistence/auth/ACL/policy tests,
agent tests, P2P regressions and packaged artifacts. A physical NVIDIA GPU test,
public TLS deployment, native Windows isolation, completed long soak and actual
VPS provisioning require separate evidence and must not be reported as passed
based on loopback tests.
