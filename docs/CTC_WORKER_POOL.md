# CTC worker pool

CTC jobs use WSL first and lisa second. Each worker exposes its configured CTC
device, precision, model availability, media root and single busy gate through
`GET /health`; the server also checks SSH access before staging the audio.
Busy hosts are skipped, and if every eligible host is busy the job waits. A
failed attempt can run once on the other host; after both fail, Resume starts a
new pair of attempts. CPU float32 and GPU float16 use the same engine identity
and cache generation; the selected device and precision are stored on the job
for diagnosis.

Set `ALIGNMENT_POOL_ENABLED=1` on the server to enable the pool. The SSH
targets default to `192.168.1.119` and `lisa`, overridden by
`ALIGNMENT_POOL_WSL_HOST` and `ALIGNMENT_POOL_LISA_HOST`. Worker HTTP URLs
default to port 3012 on those hosts; override them with
`ALIGNMENT_POOL_WSL_WORKER_URL` and `ALIGNMENT_POOL_LISA_WORKER_URL`. Give the
server SSH access to both hosts and configure the same private
`ALIGNMENT_WORKER_TOKEN` on the server and both workers. The worker's
`MEDIA_ROOT` must be writable by the SSH user, with its models under
`MEDIA_ROOT/alignment/models`. The pool copies audio into per-job directories
under that root. Pool URLs must address the remote hosts; loopback URLs and the
configured local worker URL are refused for CTC. Protect the worker HTTP ports
on the trusted network.

## Host roles and capabilities

| Host | Device | Precision | Default URL | SSH Target & Port | Concurrency | Role |
| --- | --- | --- | --- | --- | ---: | --- |
| **WSL** (`192.168.1.119`) | `cuda` | `float16` | `http://192.168.1.119:3012` | `jahn@192.168.1.119:22` | 3 | Primary CTC worker (NVIDIA GPU) |
| **Lisa** (`audiobooks.amatox.in`) | `cpu` | `float32` | `https://audiobooks.amatox.in/sonder-ctc` | `jahn@audiobooks.amatox.in:2269` (alias `lisa`) | 1 | Fallback CTC worker (CPU) |

- **WSL (Primary)**: Equipped with an NVIDIA GPU running PyTorch with CUDA `2.8.0+cu128`. Port 3012 is forwarded from the Windows host to the WSL2 virtual machine via Windows portproxy and firewall rules.
- **Lisa (Fallback)**: CPU-only worker running PyTorch `2.8.0+cpu`. Worker listens locally on `127.0.0.1:3012` and is reverse-proxied by Caddy under `https://audiobooks.amatox.in/sonder-ctc` with an IP allowlist restricted to the production server.

## Server SSH access and key layout

The server runs `ssh` and `scp` to stage audio, so the production container
needs an SSH client (installed in the image) and a key. `compose.yaml` mounts
`./data/pool-ssh` read-only as `/home/node/.ssh`.

### `data/pool-ssh` directory layout and permissions

Directory and file layout under `./data/pool-ssh` on the production host:

```text
data/pool-ssh/
├── id_ed25519       # Private Ed25519 SSH key (mode 0600)
├── id_ed25519.pub   # Public key authorized on pool workers (mode 0600 or 0644)
├── known_hosts      # Scanned host public keys for WSL and Lisa (mode 0600 or 0644)
└── config           # SSH client configuration mapping pool hosts (mode 0600 or 0644)
```

Directory permissions must be `0700` (`chmod 700 data/pool-ssh`), and file permissions `0600` (`chmod 600 data/pool-ssh/*`).

### Initial SSH key generation and configuration

Create the directory and keys once on the production host:

```sh
mkdir -p data/pool-ssh && chmod 700 data/pool-ssh
ssh-keygen -t ed25519 -N '' -C sonder-container-pool -f data/pool-ssh/id_ed25519
ssh-keyscan 192.168.1.119 > data/pool-ssh/known_hosts
ssh-keyscan -p 2269 audiobooks.amatox.in >> data/pool-ssh/known_hosts
chmod 600 data/pool-ssh/*
```

Create `data/pool-ssh/config` with stanzas for both targets:

```ssh-config
Host 192.168.1.119
  User jahn
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  UserKnownHostsFile ~/.ssh/known_hosts
  StrictHostKeyChecking yes

Host lisa
  Hostname audiobooks.amatox.in
  Port 2269
  User jahn
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  UserKnownHostsFile ~/.ssh/known_hosts
  StrictHostKeyChecking yes
```

Append `data/pool-ssh/id_ed25519.pub` to `~/.ssh/authorized_keys` on each worker host:

```sh
ssh 192.168.1.119 'cat >> ~/.ssh/authorized_keys' < data/pool-ssh/id_ed25519.pub
ssh -p 2269 jahn@audiobooks.amatox.in 'cat >> ~/.ssh/authorized_keys' < data/pool-ssh/id_ed25519.pub
```

A host that is not in `known_hosts` fails closed.

## Fresh host installation runbook

Follow these steps to set up a new CTC worker host from scratch.

### 1. Prerequisites

- Linux (or WSL2 on Windows) with Python 3.10–3.12 and `python3-venv` installed.
- Systemd with user session support.
- Network access to PyTorch package index and Hugging Face model repository.

### 2. Run the installer script

From a checkout of the repository, execute `scripts/install-ctc-workers.sh`:

For a GPU host (CUDA, e.g. WSL):
```sh
./scripts/install-ctc-workers.sh --device cuda
```

For a CPU host (e.g. Lisa):
```sh
./scripts/install-ctc-workers.sh --device cpu
```

The script performs the following actions:
1. Creates the target directory `$HOME/sonder-ctc-worker` with subdirectories `worker/`, `media/`, and `env/`.
2. Copies worker source files from `worker/`.
3. Creates a Python virtual environment at `$HOME/sonder-ctc-worker/env`.
4. Installs pinned dependencies (`torch==2.8.0`, `torchaudio==2.8.0`, `numpy==1.26.4`, `fastapi==0.121.3`, `uvicorn==0.38.0`, `faster-whisper==1.2.1`).
5. Downloads Whisper tiny and the pinned Wav2Vec2 Base CTC checkpoint (`wav2vec2_fairseq_base_ls960_asr_ls960.pth`) into `$MEDIA_ROOT/alignment/models`.
6. Configures `$HOME/sonder-ctc-worker/worker.env` (`ALIGNMENT_WORKER_TOKEN`, `MEDIA_ROOT`, `ALIGNMENT_CTC_DEVICE`).
7. Installs, enables, and starts the systemd user service `sonder-ctc-worker.service`.

### 3. Enable user lingering

Enable lingering so the systemd user service runs at system boot without requiring an interactive login:

```sh
sudo loginctl enable-linger "$USER"
```

Verify lingering state:

```sh
loginctl show-user "$USER" --property=Linger
# Output: Linger=yes
```

### 4. Host-specific network configuration

#### WSL2: Windows portproxy and firewall rule

In WSL2, the Linux VM is assigned an internal IP behind a virtual NAT switch. To allow the Sonder server to reach the worker on port 3012:

1. Retrieve the current WSL2 internal IP inside WSL:
   ```sh
   wsl_ip=$(hostname -I | awk '{print $1}')
   echo "WSL IP is $wsl_ip"
   ```

2. Open PowerShell or Command Prompt as Administrator on Windows and configure the port forward:
   ```cmd
   netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3012 connectaddress=<WSL_IP> connectport=3012
   ```

3. Add an inbound Windows Defender Firewall rule for port 3012:
   ```cmd
   netsh advfirewall firewall add rule name="Sonder CTC Worker" dir=in action=allow protocol=TCP localport=3012
   ```

4. Verify the active port forwarding rule:
   ```cmd
   netsh interface portproxy show v4tov4
   ```

#### Lisa: SSH configuration and Caddy reverse proxy

Lisa runs worker on `127.0.0.1:3012` and exposes it via HTTPS using Caddy.

1. SSH port and alias:
   SSH runs on custom port `2269` (user `jahn`, hostname `audiobooks.amatox.in`). The alias `lisa` is configured in `data/pool-ssh/config` or `~/.ssh/config`.

2. Caddy reverse-proxy block (see `deploy/ctc-worker.caddy` / `scripts/ctc-worker.caddy`):
   Insert this snippet into `/etc/caddy/Caddyfile` on Lisa inside the `audiobooks.amatox.in` block:

   ```caddy
   audiobooks.amatox.in {
   	handle_path /sonder-ctc/* {
   		@prod remote_ip 88.91.220.114
   		handle @prod {
   			reverse_proxy 127.0.0.1:3012
   		}
   		handle {
   			respond 403
   		}
   	}
   	# Other existing handlers...
   }
   ```

   `handle_path` strips the `/sonder-ctc` prefix before forwarding to the local worker on port 3012. Replace `88.91.220.114` with the production server's public IP address.

   Reload Caddy after saving:
   ```sh
   sudo systemctl reload caddy
   ```

### 5. Service management and verification

Check user service status:
```sh
systemctl --user status sonder-ctc-worker.service
```

Inspect service logs:
```sh
journalctl --user -u sonder-ctc-worker.service -f
```

Verify the `/health` endpoint:
```sh
curl -s http://127.0.0.1:3012/health | jq .
```

Expected JSON response structure:
```json
{
  "ready": true,
  "engine": "aeneas-1.7.3",
  "busy": false,
  "stuck": false,
  "busySeconds": null,
  "lastTimeout": null,
  "mediaRoot": "/home/jahn/sonder-ctc-worker/media",
  "ctc": {
    "engine": "ctc-wav2vec2-base-960h-torchaudio-2.8-v1",
    "ready": true,
    "device": "cuda",
    "precision": "float16",
    "anchorReady": true,
    "passageReady": true
  }
}
```
For Lisa (CPU), `device` will be `"cpu"` and `precision` will be `"float32"`.

## Qualification, 2026-11-07

`worker/gate_ctc.py` was run through isolated HTTP workers against the same
independent 128-utterance labelled sample. WSL used Torch/TorchAudio
2.8.0+cu128 and CUDA float16; lisa used 2.8.0+cpu and CPU float32. Each worker
used a separate temporary media root and the pinned checkpoint. The gate command
on each host was equivalent to:

```sh
ALIGNMENT_WORKER_TOKEN="$GATE_TOKEN" nice -n 10 python worker/gate_ctc.py \
  --url http://127.0.0.1:43175 --audio "$GATE_MEDIA_ROOT/timit.wav" \
  --output "$GATE_MEDIA_ROOT/alignment/result.json" \
  --reference reference.json --gold gold.json
```

WSL GPU:

| Metric | Result | Required |
| --- | ---: | ---: |
| Covered utterances | 128/128 | 128/128 |
| Both sentence endpoints ≤250 ms | 128/128 | 128/128 |
| Transition midpoints ≤250 ms | 127/127 | 127/127 |
| Missing utterances | 0 | 0 |
| Maximum endpoint or transition error | 194.3 ms | ≤1000 ms |

Gate: PASS; engine: `ctc-wav2vec2-base-960h-torchaudio-2.8-v1`; outcome: `mapped`.

Lisa CPU:

| Metric | Result | Required |
| --- | ---: | ---: |
| Covered utterances | 128/128 | 128/128 |
| Both sentence endpoints ≤250 ms | 128/128 | 128/128 |
| Transition midpoints ≤250 ms | 127/127 | 127/127 |
| Missing utterances | 0 | 0 |
| Maximum endpoint or transition error | 194.3 ms | ≤1000 ms |

Gate: PASS; engine: `ctc-wav2vec2-base-960h-torchaudio-2.8-v1`; outcome: `mapped`.

## Implementation evidence

| Proposal | Evidence |
| --- | --- |
| Route CTC to WSL first and lisa as the only fallback; never send it to production; preserve non-CTC routing. | `tests/alignment-ctc.test.ts`: unreachable, busy or incompatible WSL; legacy assignment; disabled pool; and cross-host retry tests. `tests/alignment-pool.test.ts`: production URL rejection and existing non-CTC dispatch tests. |
| Use reported device and busy state for capability and capacity. | `tests/alignment-ctc.test.ts`: incompatible or busy WSL and both workers busy. Real `/health` responses identified WSL as CUDA float16 and lisa as CPU float32 before the gates. |
| Retry a failure once on the other host, retain a retryable failure, and keep CPU and GPU in the same engine generation with device and precision for diagnostics. | `tests/alignment-ctc.test.ts`: cross-host retry and manual Resume, anchored-window failover, and the CPU and GPU metadata assertions. |
| Install the lisa environment with the pinned CPU wheels and the anchored planner dependency; document the commands. | The commands above completed on lisa; its environment imported Torch and TorchAudio `2.8.0+cpu`, FastAPI `0.121.3`, Uvicorn `0.38.0`, and faster-whisper. |
| Run both real-model gates and report their outcomes. | The two tables above show identical passing results. |
| Reproducible install script (`scripts/install-ctc-workers.sh`), systemd user service unit (`scripts/ctc-worker.service`), Caddy reverse-proxy snippet (`deploy/ctc-worker.caddy`), and documentation runbook. | `tests/install-ctc-workers.test.mjs` verifying installer CLI, help flag, syntax, service template, and Caddy configuration. |

The pool remains off by default. No schema migration is needed. The worker
ran `npx tsc --noEmit`, the focused alignment tests, `npm test`, and the Python
worker tests; the coordinator runs `npm run check -- --ref <commit>` on the
committed revision.
