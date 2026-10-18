# Session correctness investigation

Baseline: upstream `5b8617d`, client source and deployed server 0.6.10. The original checkout's untracked `out/` is preserved. Work is isolated in `pair-session-fixes`. No publication or production restart is implied by this report.

## Before-change hypothesis matrix

User reports are observations supplied with the task, not yet reproduced on two physical computers. Each hypothesis requires its own behavioral check.

| Section / reported symptom | Reproduction | Hypothesis to test | Discriminating check |
| --- | --- | --- | --- |
| 2 / member execution barrier refusal | Pending two-client fixture | Requester has not received executor-only directories/files; readiness and transport are conflated | Delay initial state, include empty directory/binary, compare manifest paths/types/hashes; verify one execution |
| 3 / caret and name inside code | Renderer source confirms exact-cursor branch | Optional exact-cursor rendering overrides whole-line mode | Run actual renderer with exact cursor, relative anchors, notebook cells and peer departure |
| 4 / newer-content on Save | Pending real editor reproduction | A physical write bypasses an open notebook's VS Code working copy | Trace all writers; save concurrent edits/outputs and independently modify disk |
| 5 / pip CA failure | Pending isolated kernel reproduction | Sandbox lacks CA/network/writable package environment | Inspect actual isolated interpreter, CA, DNS, HTTPS, pip destination and restart |
| 6 / truncated Copy button | Dashboard source confirms text button | Flexible text action shrinks in password row | Render narrow sidebar, keyboard, clipboard and stale password reply |
| 7 / slow join and false reconnecting | Pending timed route fixture | Failed route improvement overrides a healthy authorized relay | Delay/drop only candidate direct route; measure working route and readiness independently |
| 8 / public server access | HTTPS health returned 200 with normal TLS | Public endpoint works; protocol still needs a separate check | Authenticated project RPC, encrypted relay and isolated Jupyter without endpoint changes |
| 9 / ipykernel setup failure | Source pins 7.4.0; installation reproduction pending | Selected Python/index cannot resolve pinned release | Query sanitized index metadata and perform installation with actual WSL interpreter |
| 10 / unclear compute setup | User report; dialogs to inspect | Installation root, project root and sharing are mixed in prompts | Exercise normal setup, ready runtime, cancellation and Retry |
| 11 / indistinguishable run recovery | Source confirms notebook plus UUID only | Saved entries omit meaningful run context | Recover distinct accepted runs; verify cell identity and no rerun |
| 12 / unclear upload | Dialog inspection pending | Visibility and destination lack explicit explanation | CSV/folder upload, collision, private/shared listing and relative read |
| 13 / kernel outside session | Source confirms unconditional controller registration | Controller lifetime is activation-wide | Installed VSIX picker before join/after leave plus unrelated notebook while joined |
| 14 / owner cleanup | Source confirms guest-only temporary-root predicate; VPS leave removes virtual root | Temporary ownership is incorrectly inferred from role | Managed host/member roots vs original source folder; late callbacks and multi-root leave |

## Baseline environment

- Windows host: WSL Ubuntu-22.04 is available. No running Code.exe was found at inspection; registration of 0.6.10 is confirmed, activation in a currently running user Extension Host is not.
- VPS: HTTPS `https://144.172.69.57:9443/health` reports 0.6.10. Pair server, worker, proxy, Xray and VPN-manager are active. Pair listens on loopback 8788 and public 9443; VPN-manager owns 8787 and Xray owns TCP 443/8443.
- No VPN, route, firewall, SSH, unrelated service or existing project changes have been made.
- A second physical computer is not available to this agent; logical clients cannot establish physical Karing TUN acceptance.

Further entries below must distinguish source/unit checks, installed UI checks, isolated real-kernel checks, live production changes and downloaded-release verification.

## Candidate 0.6.11 findings and changes

The findings below supersede the pending baseline rows above. They establish the tested mechanisms, not an attribution of every original screenshot to the exact user's project or physical network.

### 2. Execution preparation

The two-runtime regression reproduces executor-only documents, binaries and empty directories being rejected before ordinary initial synchronization completes. The manifest remains authoritative. A retryable category-count diagnostic now triggers one bounded normal `stateRequest`, including filesystem state, and waits for its correlated reconciliation before the same execution request proceeds. Missing requester entries never delete executor data. Execution and file ACLs remain enforced. Regression cases cover successful recovery and unresolved failure; the broader runtime suite retains replay, route-loss and permission coverage. A member's exact physical Karing/TUN case was not reproduced.

### 3. Remote presence

The exact-cursor renderer previously created a border and an inline name. It now renders a whole-line translucent color while retaining relative position anchors. The participant list uses the same identity color independently of online state. Renderer tests cover exact-cursor compatibility, relative anchors and departure cleanup. A rendered production dashboard with synthetic participants was inspected in dark, light and high-contrast styles at 240 px; its color squares render under the unchanged strict CSP. Native editor/theme screenshots and two physical participants were not captured.

### 4. Notebook saves

A raw working-copy fallback could bypass an open notebook after the initial editor binding grace period. Open documents now remain owned by the editor writer for their whole lifetime. In a real Windows Extension Host, execution produced actual Python output; a deliberately stale fallback write left the physical notebook unchanged; two subsequent notebook saves preserved source, outputs and stable cell identity. Existing persistent managed-document tests retain stable save stamps. A real third-party write conflict, two simultaneous installed clients and the full autosave matrix remain unverified; the change does not disable VS Code's external-change protection.

### 5. Isolated packages

An actual 0.6.10 VPS kernel reproduced the full invalid CA path `/etc/ssl/certs/ca-certificates.crt`, followed by failed NumPy import. Mounting a certificate alone cannot provide network or writable runtime access. `%pip install` now accepts a constrained list of names/version pins, downloads binary wheels through verified HTTPS as the non-root worker, installs them inside the offline sandbox and atomically publishes a notebook/scope package environment. Arbitrary indexes, URLs, paths, shell options and source builds are rejected. The kernel mounts installed packages read-only; its general network access remains disabled. Failed installation fails the receipt without destroying a working kernel.

Real WSL and VPS bubblewrap runs, including a transient VPS unit with worker restrictions, installed NumPy, calculated `arange(10)`, restarted the kernel, retained NumPy while clearing variables, rejected a nonexistent package and successfully imported afterward. These runs use the actual accepted-command path, not a Windows installation or a base runtime ML dependency. Package state is kept outside the server release directory. Preservation through an actual deployed server upgrade was not performed. This installation mechanism supports Linux bubblewrap; container package installation is not claimed.

### 6. Password action

The shrinking text button is a fixed-width copy icon with an English tooltip and accessible name. It appears only after reveal. Both asynchronous reveal and clipboard write are fenced by endpoint/session/member identity. The production webview HTML was rendered and interacted with at 240 px in three theme styles and at 360 px in high contrast: the copy button remained 30 px wide, inside the viewport, without CSP errors. Tests cover identity changes. Native Windows clipboard verification and an installed native sidebar screenshot remain unperformed; browser fixture passwords are fictional.

### 7. Connection state

A failed background route attempt could replace ready status while the current authenticated route was still usable. Ready is now preserved only while `hasRoute(currentHost)` is true; actual route loss still enters reconnecting. Deterministic runtime/transport tests cover the distinction. Timeout values and encryption were not weakened. The user's 1-2 minute cold join was not timed on two physical computers; no median/p95/worst or sustained stability result is claimed.

### 8. Existing public endpoint

External HTTPS health and the actual compatibility RPC both return 200 with normal TLS at `https://144.172.69.57:9443`. Production remains 0.6.10. Pair services, Xray and VPN-manager retained their process IDs and configured ports during the checks. Two synthetic memberships could create/write a fresh test project, but its real execution was refused because the production worker's live-kernel limit was already reached. Existing kernels were not released. Both own test projects were deleted through the owner lifecycle API. This is not a successful production Jupyter or public WebSocket acceptance result.

### 9. Managed WSL setup

The actual Ubuntu-22.04 managed Python is 3.10.12. Published package metadata shows ipykernel 7.4.0 requires Python >=3.11; 7.3.0 supports >=3.10. Setup now prepares a versioned sibling venv with jupyter_client 8.10.0 and ipykernel 7.3.0, checks exact versions and sandbox readiness before selecting it, and leaves an existing runtime intact on failure. Startup is single-flight and errors offer Retry and diagnostics. Clean setup and actual reuse readiness passed. Unit tests cover retry/registration behavior. A full native UI matrix for cancellation, failed indexes and concurrent windows was not performed.

### 10. Compute setup path

The primary path is: connect to the server project, choose My computer, choose Setup and share, review sharing consent, prepare the managed runtime, then select the ready device under existing permissions. Files in the project, the installed runtime and the selected execution target are explained separately. Advanced export is labeled as exporting a private compute credential for a manually installed agent; it does not promise an environment installation or sharing. Stop sharing remains an explicit existing action. Actual WSL readiness passed; these native dialogs were checked through behavioral tests/source, not screenshots.

### 11. Saved results

The action is accurately labeled Inspect saved run results. Entries identify notebook, cell, state, real recorded time (or its absence), compute device and project/scope. UUIDs are not the primary text. Only the current endpoint/project/membership is included. The server supplies output-free summaries with the same ownership, ACL epoch and notebook access checks; the client fetches the full selected record afterward. Old servers remain compatible with the optional summary flag, although they may return larger list responses.

Selecting a record opens a separate bounded plaintext output summary, without rerunning code or replacing any newer notebook cells/outputs. It clearly identifies rich outputs retained on the server and summary truncation. Tests cover sorting, cancellation, selected-only full fetch, privacy fencing and records becoming unavailable. Native Quick Pick screenshots and edited-notebook visual recovery acceptance were not performed. This action is an inspection of retained output, not a promise of restoring rich outputs into cells or reattaching live execution.

### 12. Upload

The supported server upload path now states: local selection -> named project/server -> relative destination, followed by access/storage confirmation, progress and Show in Explorer. A file defaults to `data/<name>`; a folder preserves its selected subtree. Shared means published project entries; Private means owner-only server entries, not absence from the server. Files persist after leaving and the operation does not change compute selection.

Existing files require a per-file skip/rename/replace decision. Different-access destinations are rejected, including after refresh; existing public folders are not recursively republished with their unrelated private children. Path, link, size, count, membership and revision guards remain. Targeted behavioral tests cover skip/replace and privacy preservation. Partial uploads retain already transferred data and report the stopping location. A live two-client upload through the final installed UI, interruption matrix and notebook CSV read were not completed. The temporary-session UI does not gain an unsupported server upload action.

### 13. Controller scope

The stable VS Code controller API cannot hide a controller for an arbitrary subset of documents of the same notebook type. Pair now registers lazily for a dedicated optional session notebook editor type and disposes on leave. Ordinary notebooks retain their default Jupyter editor/type. Session serializer tests preserve metadata, attachments, cell IDs and outputs, including a real Python run in the Extension Host. An isolated installed 0.6.11 VSIX API probe confirmed that an ordinary notebook was `jupyter-notebook` and the Pair controller could not be selected. The installed probe predates the last recovery/upload changes; final artifact identity must be verified separately. Native picker pixels, every join/failure case and minimum VS Code 1.95 acceptance were not captured.

### 14. Workspace teardown

The temporary cleanup predicate previously inferred ownership from guest role, excluding managed host copies. It now checks the exact extension-owned session/peer workspace identity for all managed roles and protects original backing folders. Existing safe teardown, marker cleanup, delayed sweep and out-of-tree helper remain in use. Ownership tests cover managed host/member roots and protected originals. Persistent leave removes only the local virtual representation, not the server project. The full installed Explorer/dirty-notebook/multi-root/Windows-lock matrix was not performed.

## Evidence and validation boundaries

- Local Windows Extension Host: 32 tests passed, including real Jupyter execution and the added save/fallback assertions.
- Resumed Linux targeted UI/server boundary checks: 59 tests passed. Windows UI checks passed; server boundary setup on Windows encounters the existing POSIX directory fsync limitation and was verified on ext4 instead.
- Actual WSL broker/agent integration using production bubblewrap: four existing cases passed (private namespace/declassification, rename/kernel capacity, large-command transport, offline-owner/state/broker restart). The large-command case intentionally has no kernel; it is a transport-only test.
- Actual VPS/WSL package integration and transient-systemd evidence are recorded separately in the delivered acceptance logs.
- Production dependency audit, final broad artifact gate and exact asset hashes are recorded in the delivery evidence beside the candidate artifacts. Earlier c723d91 gate: 5014 passed, three pending; do not transfer that result to a newer commit without checking the delivered final result.
- The full standalone Python agent suite previously ran 34 tests with one failure: its production smoke unconditionally imports torch, which is absent from the fresh managed runtime. No ML library was added to the base runtime merely to satisfy that test.
- No physical second computer, Karing/TUN reproduction, long stability soak, ARM64/macOS/minimum-editor matrix or release download verification was performed. Logical processes and API probes do not establish those results.
- The unchanged production server was not deployed or restarted. No user VSIX/session, VPN, routes, firewall, SSH configuration, Telegram service or unrelated process was changed.

## Update from 0.6.10

Both the VSIX and the server/worker runtime need the matching candidate: the client contains editor/lifecycle/UI fixes; the worker contains isolated package support; the server adds lightweight history summaries. Updating only the client does not fix package installation on a 0.6.10 worker.

For a local candidate, install the supplied VSIX in the intended profile and use Reload Window when it is safe to restart that profile's Extension Host. Check the active extension version after reload, not only the installed registry entry. Use the existing server setup utility's local archive path for a local candidate; see its `--help` and `docs/SERVER_SETUP.md`. Do not run a release-only updater expecting an unpublished 0.6.11 tag to exist. Once a version is published, the supported `pair-notebook-server update` workflow applies. The managed utility preserves project data and worker state; it may restart Pair services as part of an explicitly requested update. It does not require hand-editing systemd, JSON or sandbox commands.

After an authorized update, compare extension/server versions and BUILD manifests, verify HTTPS plus project RPC, then execute in the chosen scoped kernel. This task prepared and verified a local candidate; it did not apply that update or publish a release.
