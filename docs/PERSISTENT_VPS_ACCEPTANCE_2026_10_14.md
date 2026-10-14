# Target acceptance continuation — 14 October 2026

Runtime source: `7b93d81fb073ea85d17eeb4f0a89365183f19def`, version 0.6.3. Base: `2537e62d28d1bba4858ec0b513863058b7cbacb7`. Integration history: [PR26](https://github.com/r7zex/jupyter_pair_ext/pull/26), originally stacked on PR25. Recorded UTC: 2026-10-14T19:58:54.624346+00:00.

The existing repairs were requalified without changing runtime code or the pinned VPS environment. The adapter still reuses `EditorSynchronizer`, `EditorTextReplica`, `PresenceRenderer` and the existing Jupyter lifecycle. Real Git tags `v0.5.18` and `v0.5.30` were verified. Row presence is advisory; same-line editing is permitted. This observation checkpoint preceded release integration and cleanup. Its evidence remains bound to runtime source `7b93d81f`; later release packaging does not change that provenance.

The [sanitized observations](evidence/persistent-0.6.3/target-continuation-2026-10-14.json) identify exact methods, backend, source and limits. Raw evidence is retained under the authorized local `acceptance/logs/`, outside Git; credentials, journals and recovery remain protected under `acceptance/private/`.

## Requirement to evidence matrix

| Requirement / scenario | Expected result | Observation / method | Status |
|---|---|---|---|
| Fast input/deletion, same-line concurrency | Local edits survive, both replicas converge, no row lock | Two native clients:141 edits/deletions each;25+25 same-line markers retained; both PASS | PASS at native API boundary |
| Unicode/UTF-16, multiline/range replacement, joins | Exact local text and eventual convergence | Native replacements and actual undo/redo; actor HTTP response delayed 900ms; local operations max77.750ms in the measured delayed phase | PASS at native API boundary |
| Cursor/presence | Permitted peer decorations remain available | Both native clients create peer cursor decorations; actual HTTP/POSIX anchor/disconnect/privacy tests pass | PASS API; pixels unverified |
| Native Save and outputs | Clean Save; source edits retain prior results | Public11133/11134, Private73, Save immediately after Run and source-edit output retention pass | PASS native API |
| Save during incoming edits | Incoming source survives; successful Save after edits settle | First Save=false while actual document version411→413; subsequent explicit Save=true/dirty=false | Qualified; one Save during active changes is not guaranteed |
| Cell structure/metadata | Insert/delete/reorder/code→markdown retain user fields | Native operations plus durable notebook/cell metadata assertions pass | PASS native API |
| Folder/offline/rename | Durable reconciliation preserves edits and Private ACL |169 fresh actual HTTP/POSIX tests include folder rename/delete/conflicts/lost ACK/offline recovery | PASS API/filesystem; two-person UI unverified |
| Real execution | Shared variables, queue, stdin/errors/interrupt, exactly-once receipt | Fresh deployed7b93 Jupyter:42, ledger1, stdin, ValueError, interrupt0.557s; no network/own-secret access | PASS target |
| Healthy silent task and stdin cancel | No artificial60s execution deadline; cancel reaches kernel | Real65s silence completes in69.783s; running at35s; input cancel gives KeyboardInterrupt | PASS target |
| Source/identity/generation/privacy fences | Old results cannot populate changed/replaced/Private cells |169 persistent tests plus actual native member Private-ID denial | PASS tested scenarios |
| Full source gate | Actual backend results, no historical CI substitution | POSIX ext4: 4942 passing / 0 pending / 0 failing | PASS for executed cases |
| Windows artifacts command | Package gate completes |4823 passing /32 pending /16 failing; POSIX fsync and Python3 alias/backend failures retained | FAIL; no full Windows-package success claim |
| Agent / bridge / audit | New checks run on appropriate backend |34 actual POSIX agent;9 Python bridge; production audit0 vulnerabilities | PASS |
| Package provenance and smoke | One clean source, all hashes, standalone operation | Original7b93 server/VSIX hashes reverified;24 packaged payload hashes; standalone storage/ACL/restart smoke passes | PASS original matching artifacts |
| Installed main activation | Real installed code activates | Fresh isolated profile: main.activate completed; manifest/activated-code hash match7b93 | PASS activation; subsequent connection probe timed out |
| Coexistence / budgets / TLS | Original services unchanged; budget respected; valid HTTPS/auth |8 original service PID/Invocation pairs unchanged; configs/firewall unchanged; OOM/kill0;35%/384MiB/128MiB; health200/admin401 | PASS scoped observations |
| Real24h | Completed, correct source/pointer, elapsed≥86400, acceptance24Hours=true |running; 26235.168s /688 executions /344 cycles; false24h | PENDING |


## Timing and evidence limits

Twenty native peer observations: median235ms, p95 415ms, max600ms. Fifteen validated HTTPS snapshot RPC observations: median119.224ms, p95/max143.739ms. This RPC includes server/application work and is not ICMP ping. Native cold/warm execution 5410/1107ms includes interpreter startup, bounded VPS CPU, results and peer observation. The local editor/native API boundary remains separate from physical input/paint timing. The run overlapped the Windows artifacts suite and the bounded VPS soak; no idle-network claim is made.

The same-editor offline controls had140 commands each: owner median14.640ms/max125.763ms and member median13.872ms/max113.106ms. Shared editing had141 commands each: owner median43.959ms/max111.459ms and member median47.049ms/max116.921ms. Synchronous staging maxima were3.697/6.776ms. These measurements show a material API-completion difference from offline control; they do not prove identical physical typing responsiveness. Server actor-ACK latency was not isolated into a fresh histogram; the900ms response-delay test specifically verifies that local edits do not await that response.

The genuine simultaneous Save test observed a new incoming document version during the first Save. It does not establish that one Save can include input arriving during serialization. Subsequent explicit Save after convergence succeeded and cleared dirty state; no incoming text was lost.

Failed harness attempts remain retained: unexercised delayed-ACK flag; a too-strong first concurrent-Save assertion; full suite from the wrong cwd; the slow old DrvFS environment; Linux Git interpreting Windows CRLF as dirty; and helper probes initially targeting the unrelated default443 endpoint/invalid RPC operation. The first ext4 run completed 4942 cases but omitted the repository's canonical `--exit` flag and retained idle timers; the final gate records actual successful process completion with that flag. These are separated from functional assertions and are not counted as passed commands. Windows full-artifacts failures remain documented. The full-main follow-on connection/Run probe timed out, so activation alone does not establish that flow.

## Pinned long run and remaining acceptance

The existing long run remains at `/var/lib/pair-notebook-worker/soak/long-20261014T124106Z`, source7b93, launched2026-10-14T12:41:06.917368Z. Its earlier49 run contributes no elapsed time. The existing heartbeat remains ACTIVE, quiet on healthy progress, references7b93 and the86400-second completion rule. Only completed+acceptance24Hours=true+elapsed≥86400 with valid ledgers/source/pointer qualifies. No24h success is claimed.

Physical keyboard/cursor pixels, original user-window reload, fully connected installed-VSIX flow, two-person folder/offline/rename UI, ordinary-text character-level live editing and macOS remain unconfirmed. Actual Windows WSL/CUDA CPU→GPU→CPU was passed historically on4f9; it is not a fresh7b93 GPU run. External/mobile VPN, original ACME renewal and bot handlers/getMe remain unconfirmed. Token extraction was previously rejected and never retried; this continuation made no bot API requests/messages.

Recovery remains the verified DPAPI CurrentUser pre7b93 archive and protected pre7b93 buffers/journals. Its encrypted SHA was checked again; this continuation did not decrypt it. The earlier isolated data restore remains historical evidence, not a new bare-machine or Python-RAM recovery claim. Documentation publication does not install new binaries or transfer the source-specific soak result to a different commit.
