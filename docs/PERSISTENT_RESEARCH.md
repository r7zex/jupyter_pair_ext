# Persistent research runs — 0.6.3

The editor session, each network connection, and each accepted compute job have separate lifetimes. Use **Pair Notebook: Run Python on VPS Compute** for unattended training. In human-host peer sessions, interactive notebook kernels and the shared host shell belong to the VS Code Extension Host. Server-owned persistent sessions instead use independent isolated interactive agents; see [their operating guide](PERSISTENT_VPS.md). They have no training-duration deadline, but cannot survive termination of that process or its machine.

## Execution ownership and recovery

The VPS broker is both an optional encrypted editor transport and a durable job registry. Using its relay does not move the host's filesystem to the VPS. A separate Python compute agent has its own owner-selected interpreter, state directory and filesystem. It runs a detached supervisor and runner, retains immutable accepted input and execution receipts, and reconciles with the broker when connections return. Preserve both broker and agent state directories.

| Event | Background job | Interactive notebook / host shell |
| --- | --- | --- |
| Guest closes or disconnects | Continues; reconnect to Compute Jobs | Observer loss alone does not interrupt the executor |
| Editor closes, reloads or changes folders | Continues on the independent agent | Extension Host lifetime remains a limit |
| Leave / End editor session | Continues; Compute Jobs stays independent | Explicit destructive paths require their own CONFIRM |
| Broker unavailable | Local execution and retained output continue | Depends on available editor transport routes |
| Polling daemon restarted | Detached execution continues; the same receipt is reconciled | Not applicable |
| Executor reboot / OOM / disk failure | May fail or become interrupted; create an explicit new continuation from a verified checkpoint | Kernel state may be lost |

An ambiguous submission is retried with its original ID and retained source, never a new hidden launch. An interrupted execution is not retried from scratch. A resume is a new job ID with an explicit parent/checkpoint identity. Successful completion is immutable; a late cancellation cannot turn a durable successful local result into Cancelled.

There is no default wall-clock deadline on accepted training, and quiet stdout does not cancel it. Network exchange, preparation, admission, message sizes, output retention and concurrency remain bounded. This does not override a provider's machine limits or keep hardware powered on.

## Owner data and immutable preparation

Interactive runs read the host's repository after the existing file barrier, including owner-only binary files. Background jobs use captured source text plus explicitly prepared data on the selected agent. Source capture is limited to 4 MiB / 256 files and is not a dataset transport.

On the executor, prepare a manifest outside the shared source snapshot:

```json
{
  "version": "transactions-2026-10-09",
  "files": [
    {"path": "datasets/transactions.bin", "size": 1234, "sha256": "REPLACE_WITH_ACTUAL_64_CHARACTER_SHA256"}
  ]
}
```

Run the agent with `--workspace /srv/owner-data --data-manifest /srv/owner-data/manifest.json`. Each entry is a regular file beneath that owner directory. The agent streams it into the run's private work directory, verifies byte size and SHA-256 before publication, resumes verified partial copies, rejects escaping symlinks, conflicting paths, changed or missing data, and retains the manifest identity. It does not modify the owner's repository, secrets, Python environments or original data.

The agent advertises its dataset identity; the submission pins that identity. A changed prepared dataset cannot silently substitute for the queued run. `PAIR_NOTEBOOK_WORKSPACE`, cwd and project `PYTHONPATH` point to the isolated run work directory. `PAIR_NOTEBOOK_SOURCE_SHA256`, `PAIR_NOTEBOOK_DATA_SHA256` and `PAIR_NOTEBOOK_DATA_VERSION` record provenance. Configurations and Python modules in the source snapshot stay fixed while collaborators continue editing the paper or next experiment.

The owner-selected Python environment is not cloned per job. Use a fixed environment or image, retain its dependency versions, and do not update pip/conda packages during an active run. The immutable snapshot covers project source, configuration and declared data; installed packages and external absolute paths remain under the executor owner's control.

Stage large owner data using the owner's existing resumable file-transfer/storage tools before submission. This release does not automatically upload host-only binary datasets to a separate agent. A run that requires unavailable prepared data is rejected with a preparation error. Read checkpoints and artifacts from `<agent-state>/jobs/<job-id>/work/` using authorized filesystem access; they are not broadcast to guests or rotated by editor autosave.

## CONFIRM and permissions

Every managed stop dialog starts with an empty field. Only the exact case-sensitive string `CONFIRM` applies the operation. Empty input, other case, extra characters, Escape and closing the dialog leave work untouched. Opening a dialog sends only a challenge request. A regular button is not sufficient.

The dialog identifies the frozen job/run IDs, experiment, executor, elapsed time, known checkpoint (or explicitly unreported checkpoint), affected descendants and possible loss since the last checkpoint. Actions exist for a single background job, background jobs of the current project/session, a notebook interruption/restart, host-terminal Ctrl+C and interactive session shutdown. Leave offers a path that retains independent background jobs.

The broker issues a random challenge bound to the authenticated principal, exact action, project/session scope, immutable target IDs and run creation generation, current authority, required permission, and a two-minute expiry. Application validates the exact text. Its durable operation record makes repeat delivery idempotent. A stale challenge cannot stop a replacement run, change its scope, or become a fresh grant after broker-authority change. Session emergency stop closes that exact scope to subsequent launches; use a new explicit editor session, or Start New Standalone Compute Session, to admit new work.

`cancel_pending` means the stop intent is retained and awaits executor acknowledgement. An offline agent is not reported as Cancelled. The agent first requests cooperative process termination, then escalates within a bounded interval against that run's supervised descendants. It does not kill every Python process or every process owned by the account. A queued run with no started process can be cancelled immediately.

If durable cancellation storage fails, the broker refuses further claims/submissions until it can reconcile the frozen intent. It persists that intent again before changing targets on a retry and acknowledges completion only after publishing the receipt. Retain the state directory and restore writable storage; do not clear pending operations to unblock a session.

The shared host terminal runs under the host account; participants see output, but only the current host enters commands. Remote shell-input RPC is rejected. Notebook execution is separately authorized and trusted Python can use OS APIs.

The existing `PAIR_VPS_CLIENT_TOKEN` represents a trusted **team operator**. Holders have broad team job rights; it does not identify individual collaborators. To distinguish users, configure `PAIR_VPS_CLIENT_PRINCIPALS` as a JSON object mapping principal IDs to `{ "token": "...", "role": "operator|member|viewer", "projectIds": ["..."] }`. Keep all tokens in private service configuration. Operators may stop scoped session work; members submit and cancel their own jobs; viewers observe. Project restrictions apply to the compute API. Relay rooms carry opaque hashes and require the encrypted session invite; the broker cannot infer their project from the current relay envelope. Agent credentials can report only assigned work. The broker derives owner identity from credentials, never a submitted boolean or user name. Audit records contain identity, action, IDs, timestamps and outcome, without credentials.

Interactive stop challenges are issued and validated by the authoritative executor and bind requester identity, host/compute epochs and the exact pending executions. Update **all participants and agents together**; legacy bare interrupt/cancel messages cannot provide this contract.

Each interactive execution has its own opaque generation, including the preparing phase. Replacing a run under the same request ID invalidates previous consent. Changing the VPS credential while its dialog is open also invalidates that dialog; start the action again with the current identity.

The UI guarantees an empty input and exact text validation. The authenticated API proves scoped authority and challenge use; it cannot prove that an arbitrary modified client physically typed the letters. It is not protection against the OS owner or trusted Python deliberately terminating a process.

## Infrastructure verification


Use the [source-specific acceptance record](PERSISTENT_VPS_ACCEPTANCE_2026_10_14.md) and retain separate evidence for each run. Loopback broker/agent tests, substituted VS Code boundaries, real Extension Host CI, external VPS, Windows, physical GPU and an actually elapsed multi-hour run are separate results. A running soak is not a completed multi-hour test.


For an independently observed Linux CPU soak after compiling the broker:

```bash
python3 scripts/persistent-soak.py start --state /srv/pair-validation/soak-0.6.3
python3 scripts/persistent-soak.py status --state /srv/pair-validation/soak-0.6.3
python3 scripts/persistent-soak.py observe --state /srv/pair-validation/soak-0.6.3
python3 scripts/persistent-soak.py cancel --state /srv/pair-validation/soak-0.6.3
```

Use a new state directory for `start`; `observe` reattaches a crashed observer to the same accepted run. The default explicitly configured workload is 14,400 steps with at least one second per step, without a computation deadline. The observer, agent, compiled broker and required transport dependency are copied and hashed before launch. Observer recovery adopts services by Linux boot/process-start identity and pidfd; it does not relaunch training. Status marks stale observation and reports actual elapsed time. Completion writes `verification.json` for one launch, steps, checkpoint integrity, source hashes and recorded outages. `cancel` obtains a fresh scoped challenge and asks for exact `CONFIRM`; it never accepts a command-line boolean as consent. This harness requires Linux pidfd/lock support and storage/machine lifetime independent of the editor; it cannot keep a terminated cloud environment alive.
