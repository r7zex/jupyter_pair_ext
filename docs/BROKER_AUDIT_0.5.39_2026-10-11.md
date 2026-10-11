# Broker cancellation audit — 0.5.39, 2026-10-11

The baseline was the actual `codex/vps-persistent-compute` head, `7e75dec3702b72f619ea9032fca310db9e53a393` (0.5.38). This report covers the current local 0.5.39 implementation, rather than repeating the previous audit's result.

## Reproduced defects and corrections

All reproductions use the real broker, loopback HTTP, authenticated clients and its filesystem ledger. Storage failures are deliberately injected at the broker's write boundary; they do not claim to reproduce a physical disk failure.

| Trigger | Baseline result | Current behavior |
| --- | --- | --- |
| The first authorized-intent write fails; the same confirmation is retried. | The retry writes a cancelled job while the persisted operation still says `pending`. | Every recovery attempt persists the authorized `applying` intent before writing target jobs. |
| Session stop persists its intent and the first target, then a later target write fails. | The next agent poll claims the remaining queued target with `cancelRequested=false`. | Serialized requests reconcile incomplete cancellation before serving polls, submissions or success receipts. A store that keeps failing returns HTTP 500 and does not admit or claim work. |
| The final cancellation receipt write fails. | A later HTTP 200 returns the in-memory receipt while the durable operation remains `applying`. | Failed receipt publication restores the in-memory `applying` state. Success is returned only after the receipt has been persisted. |
| An applied ledger receipt is altered on disk: action, scope, target ID, generation or permission. | Broker startup accepts inconsistent receipt metadata. | Startup checks the action, exact scope, ordered target IDs, immutable run metadata and result against the recorded operation. |
| A persisted recovery intent has its scope substituted while retaining the original target snapshots. | Startup cancels those original targets and closes admission for the substituted scope. | The ledger is rejected before recovery changes a job. |

Confirmation snapshots retain the authenticated owner, executor, project/session, ID/generation and immutable launch metadata. Recovery also checks those fields against the current index and loaded job. Ledger restoration rejects duplicate operation IDs, invalid permissions and target counts beyond the existing 20,000-target bound.

The existing exact `CONFIRM` API, principal binding, two-minute expiry, restart invalidation of unconfirmed dialogs, immutable target list, persisted session admission and offline `cancel_pending` behavior remain in force. A saved natural completion remains successful even when cancellation was accepted first; replaying a cancellation receipt does not rewrite the current job result.

## Validation

The three storage-failure regressions failed on the baseline (0 passed, 3 failed). The two ledger-integrity regressions also failed before the corresponding validation change (0 passed, 2 failed). After correction, the cancellation suite passes **22 tests**, including seven new regressions. The isolated TypeScript compilation and ESLint checks passed.

An additional real worker/broker test observes repeated actual HTTP `knownJobId` polls. The compact responses omit source/arguments but retain owner, project/session and generation. The test then releases the training process and checks successful completion and exactly one launch. The final checks passed **46 unique tests** across the two broker suites: 22 cancellation checks and 24 durable-compute/boundary checks. Of these, 45 passed in the combined run; the compact-poll fixture initially used a polling interval below the agent's accepted minimum, was corrected to 0.1 seconds and passed its targeted rerun. Repeated checks do not add to the unique count. Real SIGTERM/SIGKILL poller outages, broker restart, disconnected editor peers and descendant cancellation passed.

To reproduce with the normal repository build, run `npm run compile`, then `npx mocha --timeout 20000 --exit out/test/vpsCancellationConfirmation.test.js out/test/vpsCompute.test.js`. This audit used an isolated `/tmp/broker-audit-out` TypeScript output directory to avoid interfering with the main build, and explicitly enabled loopback networking in the execution sandbox. No production endpoint or deployment was changed.

## Limits

These checks use Linux CPU processes and loopback HTTP. They do not validate the user's deployed VPS, native Windows supervision or physical GPUs. The single-writer store and atomic file publication require a working retained filesystem; a confirmation whose intent write has never succeeded is not guaranteed durable across a broker crash. Persistent storage failure intentionally makes broker operations unavailable until recovery succeeds.

The API validates authenticated authority and exact scoped consent; it cannot prove a person typed the word in an arbitrary modified client, or protect against the machine owner modifying processes/state. The durable receipt describes cancellation application at that time. Current job observation remains authoritative for later natural completion or an agent's eventual stop acknowledgement.

## Checked source identities

| File | SHA-256 |
| --- | --- |
| `src/vps/server.ts` | `d2c8e05a10ca622d752f0c87c813fb814d5243096e77341888dfff37994f12c9` |
| `src/vps/protocol.ts` | `e23f479cbe27505ea486aa117dbcafa7ac665e604e18ff6f04fc3420afae86fc` |
| `src/vps/client.ts` | `79798415ce0eeb5fa11732e45f7996d4d581de5fa2ad0d4f8ea307110edf00e6` |
| `test/vpsCancellationConfirmation.test.ts` | `145082a982cc17193277aee64f809e4427ce39998d2caa91346f5b059e73aa7d` |
| `test/vpsCompute.test.ts` | `61a649033b9edb386f05798ed26fb788614885822abf984a9f89b9783b7b1afd` |
