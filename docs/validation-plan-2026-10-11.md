# Local detached compute validation, 2026-10-11

This report separates short regression evidence from the running multi-hour test.
The user selected the local broker/agent route; external VPS deployment is outside
this run's scope. Synthetic infrastructure metrics are not anti-fraud research results.

## Reproductions and fixes

The previous soak script started its observer from the mutable checkout. A second
observer that failed to acquire the deployment lock overwrote the active observer's
snapshot with `monitor_failed`. Restarting an observer also spawned fresh services
instead of recovering its surviving detached broker and polling agent.

The script now freezes itself alongside the worker, compiled source and `ws`, records
their full file hashes, and preserves the original Git revision and dirty-worktree
status. Linux boot identity, process start ticks and kernel pidfds anchor service
recovery; stale or reused PIDs cannot authorize a signal. Committed event history
restores scheduled faults. A lock contender preserves the active observer's state.
`observe` starts a detached observer without relaunching an accepted training job.

Terminal broker success is checked against the workload completion marker, explicit
step count, actual minimum workload duration, final checkpoint, isolated dataset,
single launch, scheduled fault events and frozen implementation hashes. The result
is saved to `verification.json`; failed checks remain visible.

Focused verification:

```bash
python3 -W error::ResourceWarning test/persistent_soak_test.py -v
```

Six distinct tests pass with no skips: frozen source and provenance; safe service
adoption and unrelated-process preservation; competing-observer isolation; exact
fresh `CONFIRM`; abandoned cancellation; workload/checkpoint evidence and rejection
of false success. Preparation metadata and cancellation transport use explicit
fixtures; filesystem, training workload, locks and Linux processes are real.
Running these tests against the previous script reproduced two behavioral failures
and two missing validation/recovery APIs. The two existing cancellation protections
passed on that previous script too. Before/after logs are retained at
`/workspace/validation-evidence/soak-runner/`.

## Real loopback pilot

The initial frozen worker completed 100 steps naturally in 10.4594 seconds but
rejected compact known-job poll responses, leaving the broker's result stale.
That failure is retained separately in
`/workspace/pair-validation-2026-10-11/soak-pilot/pilot-evidence.json`.
No accepted workload was cancelled. Observer services were stopped only after the
local compute result and completion marker proved natural completion.

After fixing compact-response recovery, the independent second pilot passed:
`/workspace/pair-validation-2026-10-11/soak-pilot-fixed/pilot-evidence.json`.
It completed 100 explicit steps in 14.27894 seconds with one training launch.
A live observer received SIGKILL, training stayed alive, and the detached replacement
adopted the existing broker and agent. Broker outage/restart, polling-agent restart
and observer disconnect/reconnect completed; all eight final evidence checks passed.
Fault timings were deliberately accelerated. This pilot proves no multi-hour duration.

## Detached four-hour workload

Run `soak-70596cccb0ea953b` started at 21:18:51 Moscow time on 2026-10-11 with
14,400 explicit steps, a minimum one-second step cadence, 20 CPU updates per step,
checkpoints every 60 steps and stdout every 300 steps. Completion depends on the
algorithmic step count, not an execution deadline. Its state directory is
`/workspace/pair-validation-2026-10-11/soak-long`.

The tested worker SHA-256 is
`ef4d2107e4b839a995ecbe2a15747f98426ad6533a26fe3fec87cb7128f05906`;
compiled broker SHA-256 is
`77d68a020cc33e55ccb70439924b36628f685c1b5bfa709e7b4fc6f82ce1a6da`.
The complete copied-file manifest is in the run's private `plan.json`.
Later compilation or checkout changes cannot alter these copied implementation bytes.

The saved report observation is **running at 136.4235 seconds**, step 131/14,400,
with checkpoint 120 and exactly one training launch. All normally timed fault events
were observed: broker offline/online at 30/50 seconds, polling-agent restart at
65 seconds, and observation disconnected/reconnected at 85/115 seconds.
Independent commands saw steps 18, 72 and 131 after the original launch command
had returned; Linux process identities and detached sessions were still present.
This establishes persistence beyond the launching tool's lifetime. The sanitized
observation is saved to `soak-long/status-for-report.json`; it is not a terminal result.

Observe, restart only a missing observer, or explicitly cancel this exact run:

```bash
python3 /workspace/pair-validation-2026-10-11/soak-long/implementation/persistent-soak.py status --state /workspace/pair-validation-2026-10-11/soak-long
python3 /workspace/pair-validation-2026-10-11/soak-long/implementation/persistent-soak.py observe --state /workspace/pair-validation-2026-10-11/soak-long
python3 /workspace/pair-validation-2026-10-11/soak-long/implementation/persistent-soak.py cancel --state /workspace/pair-validation-2026-10-11/soak-long
```

Cancellation displays the exact run, scope, executor, elapsed time and last checkpoint;
it requires a fresh typed `CONFIRM` and applies a one-use server challenge. EOF,
dialog abandonment, wrong case and added characters preserve the workload.
Status, event history, progress, RSS samples and checkpoints remain on disk.
The observer, broker, polling agent and managed training process run independently
of the launching command and chat. The execution workspace and machine must survive;
this test does not promise survival of provider shutdown, OOM or lost storage.

The final report must quote the latest observed elapsed duration and state. A running
four-hour plan is not a passed four-hour soak. Only terminal `succeeded` plus a passing
`verification.json` establishes this workload's completion. The full Torch reference
integration separately exercises owner data, preprocessing, model/optimizer state,
evaluation and durable result replay through the real broker.

## Availability boundaries

Linux CPU, filesystem and real local broker/worker were exercised. No physical GPU
device or `nvidia-smi`, and no `code`/`code-insiders` executable were available during
inspection. Windows, a real VS Code UI lifecycle and physical GPU execution are not
claimed. A loopback success is not an external VPS deployment result.
