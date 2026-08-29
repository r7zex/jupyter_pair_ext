# Pair Notebook Security Audit and Remediation Plan

## Status

- Audit date: 2026-08-28
- Branch: `codex/security-audit`
- Audited baseline: `a9744df` (`v0.5.5`)
- Intended audience: private collaboration between friends who deliberately share an invite
- Trusted Access / Codex Security: **not used**, by project-owner request
- Audit method: ordinary defensive source review, deterministic local tests, package/dependency inspection, and primary-specification research

## Threat model

Pair Notebook is not intended to isolate mutually hostile collaborators. A participant who is deliberately allowed to run notebook code can execute arbitrary Python in the selected project context. The security boundary must nevertheless protect against:

1. public Nostr relay and MQTT broker operators;
2. passive or active network attackers;
3. replayed or malformed network traffic;
4. an invite that is copied to the wrong person or later leaks;
5. a compromised participant attempting to impersonate another admitted participant;
6. accidental sharing of common credential files;
7. dependency or release-pipeline compromise.

Out of scope: protecting a user from code they explicitly choose to run locally, a fully compromised operating system or VS Code installation, and enterprise-grade authorization between intentionally invited friends.

## Baseline evidence

| Check | Result |
| --- | --- |
| `npm run lint` | PASS |
| `npm test` | PASS, 272 tests |
| `npm audit --omit=dev --audit-level=moderate` | PASS, 0 known vulnerabilities |
| Workspace Trust declaration | PASS, extension is disabled in untrusted workspaces |
| Webview review | PASS, nonce CSP, `default-src 'none'`, empty `localResourceRoots`, command allowlist, escaped dynamic content |
| Secret persistence | PASS, invite token, identity private key, and TURN password use VS Code SecretStorage |
| Filesystem boundary review | PASS, traversal/collision/symlink checks and bounded snapshot/materialization paths are covered by tests |
| Trusted Access / managed deep scan | NOT RUN, intentionally excluded by the project owner |

The first sandboxed `npm test` attempt was blocked by filesystem isolation in `esbuild`; the same command was rerun normally outside that sandbox and passed. This is an execution-environment limitation, not a test failure.

## Confirmed findings

### SEC-001 — High — Fixed — Remote-compute consent survives unrelated sessions

**Evidence:** The confirmation dialog says that participants in the current private session may run Python, but `toggleRemoteCompute()` writes `pairNotebook.allowRemoteCompute` at `ConfigurationTarget.Global`. `SessionRuntime` then reads that global value when advertising hardware and authorizing incoming execution and kernel-control frames.

**Impact:** After enabling compute for one friend session, a later session can inherit permission without a new session-specific confirmation. If the later invite or participant set is different, this can lead to unexpected arbitrary Python execution.

**Fix:** Keep CPU/GPU preference settings for convenience, but move the execution authorization gate into ephemeral `SessionRuntime` state initialized to `false`. The command must toggle only the active session and update presence immediately. Retain the old configuration key as a deprecated, ignored compatibility entry so an existing user setting cannot silently re-enable execution.

**Regression tests:** Prove that a globally stored legacy `true` value does not enable a newly constructed runtime, that explicit runtime opt-in advertises hardware, and that a second runtime starts disabled again.

**Resolution:** Implemented. Remote-compute permission is now ephemeral runtime state, legacy persisted values are ignored, and the focused regression suite passes.

### SEC-002 — High — Fixed — Shared relay key permits sender impersonation

**Evidence:** Nostr/MQTT emergency packets are encrypted with one AES-GCM key derived from the bearer invite. The outer `f` peer id is not cryptographically bound to the encrypted Mesh envelope. After one participant is admitted, any invite holder can encrypt a `fr` envelope, label it as that admitted peer, and submit a wire frame whose `sourceId` matches the label. The receiver then treats it as traffic from the admitted identity.

**Impact:** A leaked invite or compromised participant can impersonate the host or another friend on the emergency relay path, including sending privileged control messages. The existing signed connection handshake prevents taking over an offline identity during admission, but does not authenticate every later relay envelope.

**Fix:** Introduce relay-envelope protocol v2. Every Mesh relay envelope must carry a random message id, timestamp, target identity, and Ed25519 signature over a domain-separated canonical transcript. Verify the signature against the handshake identity (initial handshake) or pinned admitted identity (all later messages), enforce a bounded freshness window, and deduplicate signed envelope ids. Increment the Pair Notebook handshake protocol version so mixed clients fail explicitly instead of silently downgrading.

**Regression tests:** Reject unsigned, modified, wrong-target, stale, future, and replayed relay envelopes; keep a complete signed relay-only connection and data exchange working.

**Resolution:** Implemented in transport protocol v4. Every emergency-relay envelope is signed by the sender identity and bound to the session, source, intended target, message id, timestamp, and canonical payload. Receivers verify the pinned or handshake identity before processing, reject packets outside the bounded clock window, and retain a bounded replay cache. Focused unit and relay-only integration tests pass.

### SEC-003 — Medium — Fixed — Public relay announcements allow resource exhaustion

**Evidence:** Relay `announce` records contain only a syntactically valid peer id. Public relay or broker input can therefore emit unlimited unique ids. `RedundantFrameRelay.announcedPeers` and `MeshTransport.relayAttempts` did not have a complete global admission bound before initiating identity negotiations.

**Impact:** A public infrastructure operator or injector can force repeated outbound handshakes and retain attacker-chosen map entries, causing avoidable CPU, network, and memory pressure.

**Fix:** Authenticate announces with an HMAC derived from the session relay key, reject missing/invalid proofs, cap announce deduplication state, and cap unknown relay candidates/negotiations without blocking already-known peers.

**Regression tests:** Reject forged Nostr and MQTT announces, accept valid same-session announces, bound redundant announce state, and refuse unbounded unknown Mesh relay candidates.

**Resolution:** Implemented. Nostr and MQTT announce records now require a constant-time-verified HMAC bound to the session and peer id. Redundant announce deduplication retains at most 1,024 peers, while Mesh admits at most 256 unknown relay candidates without preventing a previously known friend from reconnecting. The focused Nostr, MQTT, deduplication, and Mesh-bound tests pass.

### SEC-004 — Medium — Fixed — Common local credential artifacts can enter a project snapshot

**Evidence:** The denylist already blocks `.env`, common private-key names, and `.ssh`/`.aws`/`.azure`/`.gnupg`, but it does not cover common Docker/Kubernetes client credentials, Terraform state/variable files, or several private-key/container formats.

**Impact:** A user who selects a broad project folder can unintentionally send reusable credentials to every invited participant. Friends are trusted, but accidental secret distribution and later invite leakage remain material risks.

**Fix:** Extend one shared path-classification policy with targeted, low-false-positive credential paths, names, and extensions. Apply matching protection to source archive creation so development artifacts cannot reintroduce the same files.

**Regression tests:** Cover each new sensitive pattern plus nearby safe templates/configuration files that must remain shareable.

**Resolution:** Implemented. Project snapshots and release-archive inspection now reject Docker, Kubernetes, Terraform, Pulumi, VPN, mobile-provisioning, PuTTY, cloud application-default, and OAuth client-secret artifacts. Regression coverage also preserves normal Docker Compose, Terraform source/lock files, kubeconfig examples, and variable templates.

### SEC-005 — Medium — Fixed — Release workflow actions are mutable and checkout credentials persist

**Evidence:** The release job has `contents: write`, uses moving major tags such as `actions/checkout@v7`, and leaves checkout credentials persisted while `npm ci` executes dependency lifecycle scripts. GitHub documents full-length commit SHA pinning as the immutable form of action reference.

**Impact:** A moved action tag or compromised dependency lifecycle script has a larger path to alter release state or published artifacts.

**Fix:** Pin every external action to a verified full commit SHA with a readable version comment, set `persist-credentials: false` on checkout, and keep the GitHub token exposed only to the explicit release step.

**Verification:** Validate workflow syntax, verify every pinned SHA belongs to the expected upstream repository/tag, and rerun the local release build path.

**Resolution:** Implemented. All four external actions are pinned to full SHAs verified against their official GitHub repositories (`checkout` v7.0.1, `setup-node` v7.0.0, `setup-python` v7.0.0, and `upload-artifact` v7.0.1). Checkout now sets `persist-credentials: false`; the release token remains scoped to the explicit `gh release` step. A regression test enforces immutable refs and token handling, and the workflow parses successfully as YAML.

### SEC-006 — Low — Fixed — Relay privacy documentation overstates what operators cannot observe

**Evidence:** Project contents are encrypted, but relay/broker operators can still observe a stable per-session topic, timing, packet sizes, and plaintext routing identifiers. The shared invite-derived relay key also does not provide forward secrecy if the invite is later compromised.

**Impact:** Documentation can create a stronger privacy expectation than the protocol provides. This is most relevant for users who need anonymity or post-compromise confidentiality, which is outside the friends-first product goal.

**Fix:** Correct README and protocol/architecture language: distinguish encrypted content from observable metadata, state the bearer-invite and no-forward-secrecy limitations, and recommend starting a new session/invite after suspected disclosure.

**Verification:** Search user-facing documentation for absolute claims such as “only ciphertext” and ensure the qualified threat model is consistent.

**Resolution:** Implemented. README, protocol, architecture, and transport comments now distinguish encrypted frame content from observable topics, routing ids, timing, sizes, and chunk counts. They document the bearer-invite/no-forward-secrecy boundary and tell users to end the old session and create a fresh invite after suspected disclosure.

### SEC-007 — Low — Fixed — Compute selection briefly accepts an unadvertised interpreter

**Evidence:** Immediately after session-scoped compute consent is enabled, environment discovery may still be pending. `changeCompute()` previously validated an explicit Python path only when the advertised environment list was non-empty, allowing a target with an unadvertised path to enter shared state. The executor-side availability check rejected it before execution, so this was not an authorization bypass.

**Impact:** A friend could create a temporarily unusable shared compute target and trigger avoidable execution failures during the discovery race.

**Fix:** Require every explicit Python path, local or remote, to match an advertised Jupyter-ready environment before changing shared compute state.

**Regression tests:** Accept advertised CPU/CUDA environments and reject missing paths both when the environment list is populated and while it is empty.

**Resolution:** Implemented. Compute selection now rejects any explicit interpreter that has not been advertised as Jupyter-ready; executor-side validation remains as a second boundary.

### SEC-008 — High — Open — Audited fixes are absent from the public and installed 0.5.5 release

**Evidence:** The audited branch is at `a0a9b7a`, while remote tag `v0.5.5` resolves to baseline commit `a9744df` and `origin/codex/security-audit` does not exist. Both public VSIX names have SHA-256 `0672ac59e15bccf74b75b560e7537f0ff62eb7b233fb8e17a860af57995cd0e7`; the local audited VSIX has SHA-256 `18a07cc8c0d69c5096f9dc4e75a78e057f3547f6a0445b3771bdcdd33b0117e3`. The installed bundle exactly matches the public bundle and contains neither signed relay-envelope v2 nor the session-scoped remote-compute gate.

**Impact:** Friends downloading or currently running the public `0.5.5` package remain exposed to SEC-001 and SEC-002 even though the local audit branch contains their fixes. The shared version number makes visual version checks insufficient.

**Fix:** Complete the remaining release-blocking findings, bump to `0.5.6`, create a new immutable tag at the verified commit, publish without moving or overwriting `v0.5.5`, install the downloaded public VSIX, and compare the installed bundle with the locally verified release bundle.

**Verification:** Confirm the remote tag commit, public asset hashes, downloaded archive contents, installed extension path/version, installed bundle hash, and the two fixed security markers.

### SEC-009 — Medium — Open — Remaining common credential files enter snapshots and release archives

**Evidence:** `shouldTrackProjectPath()` currently accepts `.envrc`, `.pgpass`, `.my.cnf`, `.authinfo`, `.cargo/credentials`, `.cargo/credentials.toml`, and `.config/gh/hosts.yml`. The runtime denylist, release-archive validator, and `.vscodeignore` repeat the same incomplete policy.

**Impact:** A project opened from a broad folder, or an untracked credential file beside source code, can be copied to invited friends and included in the source ZIP or VSIX. These formats can contain reusable database, registry, or service credentials that exceed the intended project trust boundary.

**Fix:** Extend every runtime and packaging boundary with basename- and path-aware rules for the confirmed credential formats while preserving ordinary project configuration and explicit safe templates.

**Regression tests:** Reject the confirmed basenames and nested credential paths case-insensitively; keep `.env.example`, `.envrc.example`, `.cargo/config.toml`, and ordinary `.config` project content shareable.

### SEC-010 — Medium — Open — Alternative direct routes bypass send completion and outbound backpressure

**Evidence:** The normal Trystero route awaits `MessageAction.send()`, but MQTT-discovered and promoted-upgrade routes invoke it with `void` and immediately decrement `inFlightBytes`/`inFlightFrames`. A focused reproduction showed `awaitDrain()` resolving while the underlying send promise was still pending. Candidate-route probe sends also leave promise rejection unhandled.

**Impact:** Large snapshots, state synchronization, and binary transfers can bypass the 128 MiB/512 MiB retained-queue accounting, send completion markers too early, interleave under transport backpressure, or lose actionable send failures. Hash and manifest checks prevent publication of incomplete files, but availability and bounded-memory guarantees are weakened.

**Fix:** Await every active-route `MessageAction.send()` inside the queue drain, route rejection through the existing queue failure path, and explicitly handle candidate-probe rejection without retiring the working relay route.

**Regression tests:** Hold and reject send promises for both `mqtt:` and `upgrade:` transports; prove `awaitDrain()` waits, limits retain in-flight bytes, failures disconnect only the failed active route, and a candidate failure leaves the working route intact.

### SEC-011 — Medium — Open — Manual release input can resolve a branch instead of the intended tag

**Evidence:** `workflow_dispatch.inputs.tag` is passed to `actions/checkout` as an unqualified ref. The pinned checkout implementation resolves an unqualified matching branch before a tag. The workflow checks only that the input string matches `v${package.json.version}` and then uses `gh release upload --clobber` for an existing release without proving that checked-out `HEAD` equals `refs/tags/$RELEASE_TAG`.

**Impact:** A write-capable collaborator or compromised maintainer account can create a same-named branch, dispatch the workflow, and replace assets attached to an existing tagged release with artifacts built from different code.

**Fix:** Resolve only a fully qualified tag, fetch tags explicitly, and assert that `HEAD` equals the dereferenced remote tag commit before dependency installation or publishing. Keep build/test work in a read-only job and grant `contents: write` only to a publishing job that consumes verified workflow artifacts.

**Regression tests:** Statically require a qualified tag ref and a tag/HEAD equality assertion; reject workflow structures that give the build job write permission or use `--clobber` without the verified-tag gate.

### SEC-012 — Low — Open — Authenticated explicit proxy passwords are stored in ordinary settings

**Evidence:** `pairNotebook.proxyUrl` is a machine-scoped string setting and the parser intentionally accepts URL userinfo. Unlike the TURN password and session credentials, an explicit proxy password therefore remains in VS Code settings rather than extension SecretStorage.

**Impact:** A proxy password is exposed to settings-file backups and other local components that can read configuration. This does not expose credentials through diagnostics, and a compromised local OS/VS Code installation remains out of scope, so severity is Low.

**Fix:** Keep the endpoint and optional username as non-secret configuration, store the password in SecretStorage, reject newly entered password-bearing explicit URLs with actionable migration guidance, and preserve credential-free HTTP/SOCKS proxy behavior.

**Regression tests:** Reject explicit URL passwords, accept credential-free and username-only URLs as intended, prove SecretStorage is used for the password, and retain diagnostic redaction.

### SEC-013 — Low — Open — Protocol documentation identifies the v4 handshake as v3

**Evidence:** `docs/protocol.md` says the admission handshake is protocol v3, while `HANDSHAKE_VERSION` is 4 and the same document later states that protocol v4 rejects v3 clients.

**Impact:** Operators can make incorrect compatibility decisions and install the old public package despite the intentional security-incompatible protocol upgrade.

**Fix:** Make every current protocol reference say v4 and explicitly point users to the new `0.5.6` release for the signed-envelope/session-consent security boundary.

**Verification:** Search current documentation and packaged release notes for contradictory protocol-version claims.

## Fix order and commit boundaries

1. `fix(compute): scope remote execution consent to each session` — SEC-001.
2. `fix(relay): authenticate emergency relay envelopes` — SEC-002.
3. `fix(relay): authenticate and bound peer announcements` — SEC-003.
4. `fix(files): exclude additional credential artifacts` — SEC-004.
5. `chore(ci): pin release actions and drop persisted credentials` — SEC-005.
6. `docs(security): document relay metadata and invite limitations` — SEC-006.
7. `fix(compute): require an advertised Python environment` — SEC-007.
8. `docs(security): record release-blocking audit findings` — SEC-008 through SEC-013 plan entry.
9. `fix(files): exclude remaining credential artifacts` — SEC-009.
10. `fix(transport): await alternative route sends` — SEC-010.
11. `fix(ci): require verified release tag checkout` — SEC-011.
12. `fix(network): store explicit proxy password securely` — SEC-012.
13. `docs(protocol): correct current handshake version` — SEC-013.
14. `chore(release): prepare and verify version 0.5.6` — SEC-008 delivery.

Each behavior change gets focused tests and its own commit. Pushes target `origin/codex/security-audit`; no force push is allowed.

## Final acceptance criteria

- All findings above are marked fixed or explicitly accepted with a documented reason.
- `npm run lint`, `npm test`, and full `npm audit` pass.
- `npm run artifacts` builds and verifies a self-contained VSIX and source ZIP.
- The produced VSIX contains the expected bundle/assets and no sensitive or nested archive entries.
- Relay-only integration tests prove identity authentication and replay rejection.
- A newly started or restored session never inherits remote-compute permission.
- The final source-to-sink review finds no remaining Critical or High issue in the stated friends-first threat model.
- The public `0.5.6` VSIX, its versioned alias, the locally verified VSIX, and the installed extension contain the same bundle bytes.
- The public and installed bundle contain relay-envelope v2 and session-scoped remote-compute enforcement.

## Primary references

- VS Code Webview security guidance: https://code.visualstudio.com/api/extension-guides/webview
- VS Code Workspace Trust extension guide: https://code.visualstudio.com/api/extension-guides/workspace-trust
- IETF RFC 8826, WebRTC threat model and security considerations: https://datatracker.ietf.org/doc/html/rfc8826
- Nostr NIP-01 event format: https://github.com/nostr-protocol/nips/blob/master/01.md
- Nostr NIP-44 limitations (metadata and forward secrecy): https://github.com/nostr-protocol/nips/blob/master/44.md
- GitHub Actions secure-use guidance: https://docs.github.com/en/actions/reference/security/secure-use
