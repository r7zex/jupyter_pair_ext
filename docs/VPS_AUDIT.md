# VPS and persistent compute audit

The branch was reviewed in descending batches of 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2 and 1 scenarios. These are **2047 adversarial test combinations**, not 2047 distinct defects. No empirical ranking of the “most popular” bugs was used. Multiple combinations can exercise the same root cause. Real findings were fixed before continuing; lifecycle and integration regressions supplement the matrices.

## Staged checks

| Batch | Scenarios | Coverage | Final result |
| --- | ---: | --- | --- |
| 1024 | 1024 | Ten independent source-schema/path corruptions and their combinations | All pass |
| 512 | 512 | Nine independent compute-registration corruptions and their combinations | All pass |
| 256 | 256 | Eight combinations of authorization, ownership, offsets and completion validation | All pass |
| 128 | 128 | Seven encrypted-packet, recipient, invitation and late-callback corruptions | All pass |
| 64 | 64 | Notebook scope, unsaved modules, concurrent edits, cancellation, session changes, size bounds | All pass |
| 32 | 32 | Real Python subprocesses: CPU/GPU visibility, Unicode, literal arguments, exit failure, cancellation | All pass |
| 16 | 16 | Three failing relay paths, redundant delivery and transport teardown | All pass |
| 8 | 8 | Bare query/fragment delimiters and embedded URL credentials | All pass |
| 4 | 4 | Queued/running cancellation before/after VPS restart | All pass |
| 2 | 2 | SIGTERM/SIGKILL of polling daemon, detached training, VPS outage and recovery | All pass |
| 1 | 1 | Yjs synchronization through encrypted VPS relay, guest submission to another PC, disconnected peers/VPS, recovered result and exactly one execution | Pass |

The first 1024-case run failed 15 combinations; the first 512-case run failed 31 combinations. Those numbers count failing combinations, not unique bugs. The initial 256-case authorization/state matrix already passed. Further problems were found through source inspection and independent recovery tests.

## Confirmed fixes

- Reject coerced array values in device/installation IDs, invisible/control characters in displayed names, malformed GPU entries and duplicate inventory indices.
- Reject Windows device-name Unicode aliases, canonical/case-equivalent file collisions, file/directory conflicts, oversized path components and unpaired surrogates before executing a snapshot.
- Validate the immutable source payload independently of retained output. A valid large training source plus 1 MiB of output previously made the entire broker fail on restart.
- Keep only job metadata in broker memory; load one source/log payload from disk per serialized operation. A dedicated child process opens a 128 MiB source store and claims a job under a 96 MiB heap limit. Source capture also checks its byte budget incrementally before building JSON.
- Compare immutable submissions using a canonical file-order digest. Reordering JSON file keys no longer turns a legitimate retry into an input conflict.
- Verify retained overlap on log retries, reject appended output after completion, and reject a conflicting repeated result. Completed state remains immutable.
- Refuse inconsistent restored job state. Enforce one broker per store, conservatively recover a provably dead local owner, stop accepting requests before draining writes, and bound body reception.
- Bound the entire HTTP response even when bytes keep arriving; reject redirects and sanitize transport errors. Authentication failures offer a reconnect action in the compute view.
- Replace the live VPS relay when configuration changes while retaining other available paths. Ignore old/stopped socket events, retry proxy failures during reconnect without throwing from a timer, and avoid bypassing an invalid explicitly selected proxy on the VPS path.
- Persist the full immutable submission in private extension storage before sending it. A lost response and an editor restart retry the same source and ID. An absent job listing is never treated as proof that an earlier request cannot still commit. Block double-click submission while selection is pending.
- Snapshot all shared Python sources and open dirty modules after selection dialogs finish. Abort when the session or VPS changes during selection; notebook-generated entrypoints do not overwrite existing sources.
- Pin GPU selection to its UUID through queueing and CUDA enumeration changes. Resolve owner-selected relative interpreter paths without dereferencing virtual-environment symlinks; expand home paths in agent configuration.
- Stop a runner if output draining fails; close its stdout pipe; continue draining verbose output after local retention fills. Cancellation and process-group cleanup are covered with real Linux child processes.
- Use monotonic recovery grace instead of wall-clock age and check retained input identity. Ambiguous launches are interrupted rather than rerun. Reject non-finite polling intervals.
- Stop old-endpoint log watchers and discard late responses; reset UTF-8 decoding after a retention gap. Show setup/empty-job guidance. Attach rejection assertions before teardown in an existing runtime test, eliminating misleading late-handler warnings.
- The broad regression run exposed a preexisting Jupyter cancellation race: a SIGINT sent at the initial `busy` notification could arrive before ipykernel installed its execution handler, allowing a cancelled 30-second cell to finish. Defer the signal briefly and bind its delivery to that exact pending execution; discard it after completion, shutdown or restart. Real-kernel checks repeat immediate cancellation five times and verify that a completed cell's delayed interruption cannot affect the next cell.

## Reproduction

```bash
npm run compile
npm run lint
npm run test:vps:audit -- --report=/tmp/pair-vps-audit.json
npm run test:vps:agent
# On this cloud workspace the prepared Jupyter dependencies are here:
PYTHONPATH=/workspace/.jupyter_pair_ext_python node node_modules/mocha/bin/mocha.js \
  --timeout 20000 --exit 'out/test/**/*.test.js'
node scripts/make-artifacts.mjs --preflight-only
```

`test:vps:audit` runs the batches in order and checks each expected case count. Its report records passes, failures and skipped cases separately. On Windows, the Linux SIGTERM/SIGKILL and acceptance cases are skipped rather than presented as verified. Set `PAIR_NOTEBOOK_AGENT_PYTHON` to choose the audit interpreter.

The complete TypeScript suite covers CRDT/file synchronization, notebook/controller behavior, network matrices, proxy handling, relay handshakes and startup recovery alongside the new VPS tests. The original Python run contained 32 matrix cases and 7 additional agent regressions, including a 34 MiB output producer. [First-round results](VPS_AUDIT_RESULTS.json) preserve that run.

## Second independent audit

The second cycle adds another **2047 scenarios**, rather than renaming or recounting the first matrix. Both cycles are retained and rerun together. Counts below describe failing combinations before each fix, not distinct defects or bug frequency.

| Batch | New coverage | Initial failing combinations | Final result |
| --- | --- | ---: | --- |
| 1024 | Valid Unicode/path/argument variations combined with broken source/argument Unicode, C1 label controls and noncanonical GPU indices | 960 | All pass |
| 512 | Valid compute profiles combined with repeated physical GPU UUIDs, invalid UUID prefixes and malformed UUIDs | 192 | All pass |
| 256 | UTF-8 byte splits, full/partial log retries and invalid completion combinations | 128 | All pass |
| 128 | Binary payloads, destination binding, cross-session packets, readiness and teardown combinations | 0 | All pass |
| 64 | Long ASCII/Unicode notebook names, directories, scope, dirty imports and mixed-language cells | 32 | All pass |
| 32 | Cancellation persisted before launch, combined with missing GPU, damaged source, unsafe entrypoint, existing work files and restored receipt | 32 | All pass |
| 16 | GPU UUID hex-case differences, reordered-input replay, running cancellation and broker restarts | 0 | All pass |
| 8 | Endpoint-specific pending receipts and deletion by another editor after directory listing | 4 | All pass |
| 4 | Slow headers/body over direct HTTP and an explicit HTTP proxy | 4 | All pass |
| 2 | Real loopback HTTPS: default certificate rejection, trusted TLS deadline and redirect credential isolation | Checked after deadline fix | All pass |
| 1 | Two-way Yjs source synchronization, repeated guest submission, real CPU optimization/checkpoints, disconnected editors, VPS outage and recovery with the polling agent still alive | 0 | Pass |

Additional regressions reproduced a maximum-size mesh frame rejected by the VPS envelope, an earlier log selection replacing the latest after delayed credential loading, and endless polling after HTTP 401/403/404. A further check caught an emoji split by job-title truncation. These cases are outside the 2047-case matrix.

The fixes reject malformed Unicode before accepting work; keep GPU indices canonical and GPU identities unique while matching UUID hex digits without case sensitivity; require exact integer completion codes; bound the VPS routing envelope separately from its payload; generate portable notebook filenames and Unicode-safe titles; persist cancellation before spawning or preparing sources; tolerate only genuinely missing reconciled receipts; and stop unrecoverable log polling with a reconnect/refresh action.

The agent now enforces a total HTTP exchange deadline instead of resetting its wait whenever another byte arrives. Direct HTTP, an HTTP proxy, HTTPS body reads, HTTPS proxy CONNECT headers and valid EOF-delimited JSON are covered. TLS certificate verification, environment proxy configuration and redirect rejection remain enabled. OS DNS resolution can still exceed the requested deadline before a socket exists; after resolution, an expired request is rejected before sending credentials.

```bash
npm run test:vps:audit:round2 -- --report=/tmp/pair-vps-audit-round2.json
python3 -W error::ResourceWarning test/vps_agent_audit.py -q
```

The HTTPS audit generates temporary local certificates using `openssl`; the installed agent itself still requires only Python's standard library. The current Python suite contains 79 checks. [Second-round results](VPS_AUDIT_ROUND2_RESULTS.json) record both matrices and the full regression run. Native VS Code rendering, physical GPU training and Windows service lifetime retain the limits below.

## Verification limits

The cloud tests use loopback networking and real CPU processes on Linux. GPU inventory/UUID behavior is simulated; they do not train on physical CUDA hardware. UI tests substitute the VS Code API boundary while exercising the production controller, broker and persistence. Native extension-host E2E was attempted but could not start because this environment has no VS Code executable (`Could not find VS Code`).

Public VPS certificates/routing, actual VS Code rendering, physical GPUs and Windows Task Scheduler/service process lifetime require their own environments. No credentials or access to the user's VPS/compute PC were supplied. The editor session retains its existing host-availability rules; the independent persistent-job path is what survives editor shutdown. Computation still requires the selected PC to remain powered on.

A directory lock deliberately refuses unknown/incomplete ownership or another hostname. It is not a distributed lock for shared container/network filesystems. Retain the broker store and agent state; never remove a live writer's lock or active execution receipts to force recovery.
