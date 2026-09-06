# Editor synchronization repair

Baseline: `4a3e012` (0.5.16).

- [x] Reconcile an initially stale open text document without publishing stale offsets or losing typing during binding. Preserve already dirty buffers as local work.
- [x] Check line locks in canonical CRDT coordinates, including pending/rejected remote applications.
- [ ] Cancel editor queues and in-flight continuations when the synchronizer or document is disposed.
- [ ] Reuse released text replicas with incremental updates instead of cloning the whole notebook per remote keystroke.
- [ ] Run targeted regressions, full release gates, and inspect the packaged artifacts.
- [ ] Push the fixes and publish a new immutable GitHub release.

Validation distinguishes deterministic VS Code boundary tests from installed UI and physical two-machine acceptance.

First pair: 85 focused tests passed; TypeScript and lint passed. The new integration matrix produces 11 failures against the original sync implementation and passes after repair. Initial text rebasing uses the already-pinned `diff` 8.0.3 package with a bounded diff timeout.
