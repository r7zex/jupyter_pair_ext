# Editor synchronization repair

Baseline: `4a3e012` (0.5.16).

- [x] Reconcile an initially stale open text document without publishing stale offsets or losing typing during binding. Preserve already dirty buffers as local work.
- [x] Check line locks in canonical CRDT coordinates, including pending/rejected remote applications.
- [x] Cancel editor queues and in-flight continuations when the synchronizer or document is disposed.
- [x] Reuse released text replicas with incremental updates instead of cloning the whole notebook per remote keystroke.
- [ ] Run targeted regressions, full release gates, and inspect the packaged artifacts.
- [ ] Push the fixes and publish a new immutable GitHub release.

Validation distinguishes deterministic VS Code boundary tests from installed UI and physical two-machine acceptance.

First pair: 85 focused tests passed; TypeScript and lint passed. The new integration matrix produces 11 failures against the original sync implementation and passes after repair. Initial text rebasing uses the already-pinned `diff` 8.0.3 package with a bounded diff timeout.

Second pair: 94 focused tests passed, including cancelled queued/in-flight work, independent lagging cells, spare renames, and rejection isolation. An in-memory regression through actual `SessionRuntime.leave()` with a simulated final backing-write failure retains both notebook cells and creates no project/replica after teardown.

The 1,000-cell / 10 MB source benchmark used 10.2 MB per remote keystroke before repair (median 63.6 ms). After one full warmup snapshot, six incremental edits encoded 4.9 KB each and took 10.1-18.0 ms. These measurements cover the local production replica path, not installed VS Code UI latency.
