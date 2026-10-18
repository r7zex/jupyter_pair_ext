# Pair Notebook 0.6.13 verification

## Notebook lifecycle changes

Session editor switching now has one in-flight operation per URI. It closes only clean tabs before requesting the new type. Dirty Jupyter documents stay open, with a message explaining Save/Save As; switching resumes after the user saves. Same-name local notebooks stay ordinary Jupyter notebooks. No save or discard is performed to force a switch.

File-scoped HTTP 404 and 403 errors no longer disconnect the project. Heartbeat/project failures still enforce authentication, revocation, missing-project and compatibility checks. Deleted notebook instances are retired before asynchronous archiving. Synchronization, queued admission and output callbacks cannot revive them. A recreated epoch uses a distinct editor URI, keeping the old dirty document detached. The Open recovery copy action opens its archived notebook in ordinary local Jupyter. A delete may retry once after a concurrent live edit only when the server still reports the same notebook epoch.

Recovery archives contain the displayed notebook, including outputs and metadata. Replica journals are scoped by endpoint, session, membership, path and server epoch. The session serializer retains a local epoch marker through VS Code backup serialization; it is excluded from shared user metadata. Old epochs are archived, never replayed automatically into a new file. Existing global storage and journals are retained.

Notebook serialization now preserves every CRLF source line. Its former dot-based split regex skipped text before carriage returns, truncating Windows recovery copies. Focused regressions cover CRLF, blank lines and mixed line endings. The session serializer also accepts the empty destination model created during Save As.

The `pair-vps` provider is registered once before asynchronous network setup. Connection changes use provider-side availability and per-file readonly permissions instead of unregister/register gaps. Execution responses optionally include their admitted notebook identity so newer clients can fence peer output rendering after replacement.

## Validation

- Windows VS Code Extension Host: 34 tests passed, including real Jupyter-to-session model switching, concurrent selection, dirty deferral, same-name local notebooks, repeated saves, Python execution and the existing native editing cases.
- Focused tests cover actual authenticated HTTP collaboration, same-row concurrent edits, source/identity admission, output persistence, Public/Private boundaries, deletion retirement, delayed callbacks, epoch URI single-flight and restored dirty epochs.
- TypeScript compilation, ESLint and focused save/provider regression checks passed. Exact-head CI and release packaging outcomes are available in GitHub Actions and the embedded build manifests.

The complete Windows deletion/recreation/reconnect/Reload Window scenario passed in an isolated profile with the production controller/filesystem/synchronizer classes, a loopback WSL server, a real isolated Python worker and synthetic test notebooks. The test compared the entire displayed source with each recovery archive, opened those copies as ordinary Jupyter notebooks, preserved the detached dirty documents, rejected stale saves and checked repeated current-epoch saves after reload. It does not modify the production VPS. Detailed observations and earlier failed candidates are recorded separately with the delivered acceptance artifacts.

## Update and limits

Install the new VSIX on each participating computer and reload the intended VS Code window. The server update is a separate explicit administrator action using the matching setup utility. Publishing this release does not update any running server. Existing project data, credentials, recovery journals and user buffers must be retained.

Physical two-computer acceptance, live production-account acceptance, network latency distributions and a new long soak are not established by this lifecycle test. Native lifecycle tests use synthetic files and local loopback transport; they do not establish arbitrary third-party editor behavior. Older servers may omit notebook identity on execution responses; their output lineage remains protected server-side, while the additional client identity check requires the new server package.
