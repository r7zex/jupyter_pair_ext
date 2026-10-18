# Pair Notebook 0.6.11 verification

## Update

Install the matching VSIX on every participating computer and reload the intended VS Code window. Update the server/worker through the matching setup utility or `sudo pair-notebook-server update`. Server updates stop active Python kernels; save notebooks and export any needed in-memory results first. Existing project data, membership credentials and configured server endpoints are retained by the managed installer. The release operation itself does not update a running server.

## Changes and behavioral evidence

- Execution preparation recovers incomplete requester state once through normal synchronization and retains manifest/access/replay checks. Deterministic two-runtime cases cover missing documents, binary files and directories.
- A real Windows Extension Host executed Python, rejected an attempted stale raw write behind an open notebook, and saved source, output and stable cell identity twice. Whole-line presence retains relative anchors; the actual dashboard HTML was rendered in three theme styles with fictional participants and narrow password controls.
- The final locally packaged server passed four broker/agent integration cases inside an isolated non-root VPS systemd unit, including private namespace boundaries, notebook rename, retained state/results, owner disconnect and broker restart. One of these cases is intentionally transport-only.
- The same server archive installed NumPy through `%pip install`, calculated `arange(10)`, retained the package after kernel restart while clearing variables, rejected a nonexistent package and successfully imported afterward. General user-cell networking remains disabled; package downloading uses a constrained verified-HTTPS worker path. Binary-wheel installation supports Linux bubblewrap; container package installation is not claimed.
- Actual WSL Python 3.10.12 setup and runtime reuse passed readiness with jupyter_client 8.10.0 and ipykernel 7.3.0. Setup prepares a versioned runtime before selection. Advanced credential export is distinct from managed setup/sharing.
- Saved-result summaries preserve access checks and load full outputs only after selection. Inspection does not rerun code or replace current notebook output. Upload collision decisions preserve privacy; existing public folders are not recursively republished.
- An installed, activated local candidate confirmed that an ordinary `jupyter-notebook` document could not select the Pair controller. The session serializer preserves metadata, attachments, IDs and outputs. Host cleanup ownership no longer depends on guest role.

## Gates and limits

The prior local candidate gate passed 5021 tests with three optional PyTorch scenarios pending, nine bridge tests and the package parser test; production dependency audit reported zero vulnerabilities. Windows Extension Host passed 32 tests. A separate fresh-runtime Python agent suite had one torch-prerequisite failure out of 34; it is not counted as a successful complete suite. Release CI installs its declared training dependencies and requires the full suite without pending tests. The exact publishing commit and CI outcomes are recorded in GitHub Actions and the embedded client/server manifests.

Full details and the original hypothesis matrix are in [Session correctness acceptance](SESSION_CORRECTNESS_ACCEPTANCE.md). Those entries describe the local candidate's observations; CI-built release files have their own immutable hashes and provenance and are verified after publication.

Not established by these checks: two physical Windows computers using Karing TUN, cold/warm join median/p95/worst, a long stability soak, the full installed Explorer/dirty/multi-root teardown matrix, native Quick Pick screenshots or native clipboard behavior. A production test project hit the existing live-kernel quota; user kernels were not released and the test projects were removed. Separate packaged-server units supplied real isolated Jupyter evidence without restarting production Pair services, Xray, VPN-manager, SSH or other services.

Windows deletion of the owned local test profile/generated files was rejected by automatic approval policy; those directories were retained without bypassing the block. Linux test environments were removed after evidence was saved. This is independent of the product teardown regression.
