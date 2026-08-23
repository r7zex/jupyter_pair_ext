# Pair Notebook 0.3.1 build report

## Verification results

- `npm run lint`: PASS.
- `npm test`: PASS, 164 tests in approximately 50 seconds. The clean run covers TypeScript compilation, Trystero transport, authenticated admission, CRDT convergence, host failover, persistence, notebook execution, binary transfer, UI startup, and multi-runtime integration behavior.
- `python -m unittest discover -s test -p jupyter_bridge_unit.py -v`: PASS, 7 Python bridge tests.
- `npm run test:live`: PASS. Two independent Node processes discovered one another through public Nostr relays and exchanged an acknowledged payload over a real WebRTC data channel.
- Clean bundle load with a stubbed VS Code API: PASS. The packaged runtime loads without an installed `node_modules` tree.
- `npm ls --all`: PASS.
- `npm audit`: PASS, 0 vulnerabilities.
- `npm audit --omit=dev`: PASS, 0 vulnerabilities.
- Manual source-to-sink security review: PASS with no remaining known finding. The review covered authenticated admission, invite and identity handling, message limits, path containment, binary and notebook persistence, process execution, webview input, atomic writes, autosave cleanup, and artifact composition.
- Managed Codex Security Deep Scan: NOT RUN. The scanner could not safely start because this desktop session did not provide its required managed filesystem permission profile. This environmental limitation is recorded rather than represented as a scan pass.
- `npm run artifacts`: PASS. The package checker rejects missing runtime assets, external runtime imports, stale build files, unsafe archive paths, nested archives, generated caches, `node_modules`, symbolic links, and secret-like files.
- `code --install-extension .\pair-notebook-0.3.1.vsix --force`: PASS. VS Code reports `pair-notebook.pair-notebook@0.3.1` after installation.

## Reproduction commands

```powershell
npm run lint
npm test
python -m unittest discover -s test -p jupyter_bridge_unit.py -v
npm run test:live
npm ls --all
npm audit
npm audit --omit=dev
npm run artifacts
code --install-extension .\pair-notebook-0.3.1.vsix --force
code --list-extensions --show-versions
```

Artifact sizes and SHA-256 hashes are emitted by `npm run artifacts` and can be verified independently with `Get-FileHash`.
