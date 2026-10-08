# Your VPS and persistent compute machines

Pair Notebook can use your own VPS as an additional **end-to-end encrypted P2P relay** and as a **durable background-job broker**. A standalone agent on a PC executes Python jobs using that PC's CPU or NVIDIA GPU. The PC connects outward over HTTPS; it does not need a public IP, inbound port, VS Code, or the Session Host role. You can also run an agent on the VPS itself.

Once the agent starts a job, switching off the submitting laptop, leaving the collaborative session, closing VS Code, losing the VPS connection, or restarting the agent service does not terminate its detached training process. Reconnect later, from any team computer, to inspect the shared job and output. The compute PC must remain awake and powered on.

## 1. Install the service on the VPS

Use Node.js 20+ and Python 3.10+ for agents. From this feature branch on a Linux VPS:

```bash
git clone --branch codex/vps-persistent-compute https://github.com/r7zex/jupyter_pair_ext.git
cd jupyter_pair_ext
npm ci
npm run compile
```

Generate **two different** tokens with `openssl rand -hex 32`: a team token for editors, and an agent token for each compute machine. Keep credentials outside the repository. For example, create `/etc/pair-notebook/vps.env`, owned by the service account and readable only by it:

```ini
PAIR_VPS_CLIENT_TOKEN=REPLACE_WITH_RANDOM_TEAM_TOKEN
PAIR_VPS_AGENT_TOKENS={"gpu-pc":"REPLACE_WITH_DIFFERENT_RANDOM_AGENT_TOKEN"}
PAIR_VPS_DATA=/var/lib/pair-notebook-vps/jobs
PAIR_VPS_BIND=127.0.0.1
PAIR_VPS_PORT=8787
```

Each agent has its own ID and token. The team token can submit, read and cancel jobs and access the P2P relay. An agent token can only claim and report jobs assigned to its machine. This service instance is one trusted team's workspace; use separate service instances and credentials for separate teams.

Run `npm run vps:server` with those environment variables, or install a systemd service (adjust user and checkout path):

```ini
[Unit]
Description=Pair Notebook VPS relay and job broker
After=network-online.target
Wants=network-online.target

[Service]
User=pair-notebook
WorkingDirectory=/opt/jupyter_pair_ext
EnvironmentFile=/etc/pair-notebook/vps.env
ExecStart=/usr/bin/node /opt/jupyter_pair_ext/out/src/vps/cli.js
Restart=on-failure
StateDirectory=pair-notebook-vps
UMask=0077

[Install]
WantedBy=multi-user.target
```

Expose it through a TLS reverse proxy. A minimal Caddy configuration is:

```caddyfile
pair.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy automatically forwards WebSockets. With nginx, enable HTTP/1.1 and WebSocket Upgrade headers, and permit JSON request bodies up to 4 MiB. Keep the Node service bound to loopback and expose HTTPS port 443. Start exactly one broker process for each data directory; the job store is a single-writer service. Retain and back up its directory across upgrades.

## 2. Install the compute agent on the powerful PC

Copy `scripts/pair-notebook-agent.py` to the PC. It uses only the Python standard library; VS Code and this repository's Node dependencies are unnecessary on that machine. Install your training libraries in the Python environment you want it to use.

Save that machine's agent token in a private file, for example `/etc/pair-notebook/agent.token`. Then run:

```bash
python3 /opt/pair-notebook-agent.py \
  --url https://pair.example.com \
  --id gpu-pc --name 'Training PC' \
  --token-file /etc/pair-notebook/agent.token \
  --python /opt/training-venv/bin/python \
  --workspace /srv/training-data \
  --state /var/lib/pair-notebook-agent
```

`--python` is selected by the PC's owner. A submitted job cannot replace it. NVIDIA GPUs are discovered through `nvidia-smi`; selecting a GPU sets `CUDA_VISIBLE_DEVICES` for the training process, while selecting CPU hides CUDA devices. Your selected environment must contain the CUDA-capable framework and drivers needed by your code.

`--workspace` points at existing datasets or other files on the compute PC. Source snapshots execute in a separate directory for each job. Refer to existing datasets without uploading them from your laptop:

```python
import os
from pathlib import Path

data_directory = Path(os.environ['PAIR_NOTEBOOK_WORKSPACE'])
dataset = data_directory / 'datasets' / 'my-training-data'
# Save checkpoints to this directory to reuse them from future jobs:
checkpoints = data_directory / 'checkpoints'
checkpoints.mkdir(parents=True, exist_ok=True)
```

For unattended operation, install an agent service:

```ini
[Unit]
Description=Pair Notebook persistent compute agent
After=network-online.target
Wants=network-online.target

[Service]
User=training
ExecStart=/usr/bin/python3 /opt/pair-notebook-agent.py --url https://pair.example.com --id gpu-pc --token-file /etc/pair-notebook/agent.token --python /opt/training-venv/bin/python --workspace /srv/training-data --state /var/lib/pair-notebook-agent
Restart=always
RestartSec=3
# Stop/restart the polling daemon while allowing detached jobs to continue.
KillMode=process
UMask=0077

[Install]
WantedBy=multi-user.target
```

The service user must be able to write its state and dataset/checkpoint directories and use the GPU. Keep the `--state` directory: it contains the installation identity, execution receipts, job sources, output and results. Two daemons cannot share it simultaneously.

On Windows, run the same script with the selected Python executable and Windows paths. Configure Task Scheduler to run it at startup, including when the user is not logged on. Detached job processes survive closing the polling agent; a PC reboot terminates active training. Windows service wrappers must also be configured to leave detached child processes running on an agent-only restart. Windows service and real GPU operation require verification on your hardware.

## 3. Connect every collaborator

Install an extension built from this branch on every editor computer. Open a trusted workspace and run **Pair Notebook: Connect to VPS**, enter `https://pair.example.com` and the **team** token. The token is stored in VS Code SecretStorage, bound to the exact endpoint; settings contain only the server URL.

Each collaborator keeps using the normal session invitation for editing. Start or rejoin the session after connecting the VPS to add its private relay. Direct P2P and the existing public relay paths remain available. Only holders of the session invite can decrypt relay frames; the VPS handles opaque ciphertext and routing metadata. The VPS service does not need the session invitation secret.

Background job code and output use authenticated HTTPS between the team, broker and agent and are stored on the VPS/PC. Team members authorized to submit jobs can execute Python with the agent account's privileges; run agents under a dedicated account appropriate for your trusted collaborators.

## 4. Submit and follow training

Use the **VPS Compute** view in the Pair Notebook sidebar, or these commands:

| Command | Result |
| --- | --- |
| Connect to VPS | Configure the HTTPS endpoint and securely save the team token. |
| Run Python on VPS Compute | Choose a PC and CPU/GPU, then submit the open Python script or selected notebook scope. |
| Show VPS Jobs | List the team's jobs and follow a job's retained output. |
| Cancel VPS Job | Cancel a queued job or request termination of a running job and its child processes. |
| Refresh VPS Compute | Refresh machines and jobs. |

Click a machine to select its compute device; click a job to follow its output. You can submit from a guest or without an active P2P session. Registered offline agents can receive queued jobs, which start when they reconnect. The VPS processes one job at a time per agent, in queue order.

For collaborative projects, the extension snapshots the current `.py` files from shared document state, including the active editor's unsaved code. A notebook can submit its active cell or all Python code cells as a fresh Python program. IPython magics, interactive input and existing Jupyter kernel variables are unavailable in background jobs. Regular live notebook execution retains its existing Session Host kernel behavior; background execution is selected explicitly with **Run Python on VPS Compute**.

The submitted source is immutable for that job: later collaborative edits do not alter running training. At most 256 source files and 4 MiB of JSON input can be sent. Outside a collaborative project, only the active Python file/notebook is sent. Install dependencies on the agent in advance; scripts are launched without a shell or automatic package installation. Large datasets stay on the PC.

## Persistence and recovery

- A disconnected laptop or stopped polling daemon does not stop the detached training process. The agent buffers output on disk and reports it after reconnecting.
- VPS restarts preserve queued jobs, running claims, cancellation requests, completion results and output. Retried submissions with the same ID do not create a second job.
- An agent restart with its original state directory reconnects to the same runner and reports its result. An ambiguous launch or a PC reboot is reported as interrupted when no runner holds its OS lock. Such jobs are never automatically rerun. Resume from a checkpoint in a new job if needed.
- A different agent installation cannot take over an already running claim. Restore the original state directory to reconcile it; do not delete agent state as a recovery shortcut.
- Cancellation of an offline agent is delivered when it reconnects. Cancellation is a request until that agent confirms it; it cannot power off a remote process while the network is unavailable.
- Each job retains its source, files and checkpoints in `<agent-state>/jobs/<job-id>/work/`. Retrieve artifacts through your existing SSH/file access to that PC, or save them into `PAIR_NOTEBOOK_WORKSPACE` for future jobs. The VPS UI displays status and logs; it does not stream model weights or datasets.
- The broker retains the last 1 MiB of each job's output. The PC stores up to 32 MiB of output and continues draining further output so verbose training cannot block on a full pipe. Job files remain until the owner archives them.
- The broker supports up to 1000 stored jobs. Archive completed job JSON files while the broker is stopped, and retain any active claims. Use one broker process per store.

The P2P editor session retains its existing host availability rules. A persistent compute agent does not become the editor Session Host. Background jobs and their VPS view remain available independently of that editor session.

## Verification in this branch

Automated loopback checks cover credential separation, path validation, idempotent submissions, durable claims after a VPS restart, bounded/idempotent log replay, queued/running cancellation, encrypted P2P delivery and reconnection. A real Python agent test kills the polling daemon and stops the VPS while the detached program continues, then reconnects with the original state and verifies exactly one execution and recovered output. A second real-process test verifies cancellation.

These checks use local CPU processes. Deployment certificates, public-network routing, Windows service wrappers and physical GPU training must be tested on the VPS and compute PCs you configure.
