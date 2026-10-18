# Pair Notebook 0.6.14 verification

This client hotfix blocks raw filesystem Overwrite of an existing server notebook when its writer is a local or ordinary Jupyter editor. That path bypassed CRDT saving and could replace the server epoch. The legacy Jupyter buffer is now archived and retained while the current server notebook opens with its epoch URI. Explicit replacement through Upload Files retains its separate confirmation and privacy checks.

Focused validation: 90 provider/synchronizer/compatibility tests passed on Linux. A real Windows VS Code guest used a loopback Linux server with a same-name local notebook. Overwrite was rejected, the local file and server epoch were unchanged, the dirty Jupyter buffer survived, its full recovery copy opened and closed, the current server notebook was deleted and the sibling notebook continued saving. TypeScript and scoped ESLint passed. The complete long release/CI matrix is not claimed by this record.

Install this VSIX on participating editors. The fix does not require updating the running server. Production VPS deployment, physical two-computer acceptance and a new long soak were not performed. Existing buffers, global storage and journals must be retained.
