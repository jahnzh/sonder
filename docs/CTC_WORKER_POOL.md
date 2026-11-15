# CTC worker pool

All alignment work runs on these pool hosts only: alignment maps, ebook
candidate probing and passage locating (**Read from audio**). The production
server runs no alignment worker; its `sonder-alignment` container was retired
in #279. CTC jobs use WSL first and lisa second. Each worker exposes its configured CTC
device, precision, model availability, media root, job slots and requests in
progress through `GET /health`; the server also checks SSH access before staging
the audio. A worker runs up to `slots` requests at once
(`ALIGNMENT_WORKER_SLOTS`, 1 to 16, default 1), sharing its resident model, and
the server admits that many jobs to it. A host with every slot taken is skipped,
and if every eligible host is busy the job waits. A
failed attempt can run once on the other host; after both fail, Resume starts a
new pair of attempts. CPU float32 and GPU float16 use the same engine identity
and cache generation; the selected device and precision are stored on the job
for diagnosis.

Set `ALIGNMENT_POOL_ENABLED=1` on the server to enable the pool; reading sync
is shown as available, and newly linked pairs are queued, only when it is set
together with `ALIGNMENT_WORKER_TOKEN`. A leftover `ALIGNMENT_WORKER_URL` in
`.env` is ignored. The pool hosts are configuration (ADR 0013; see "Host
configuration" below); by default they are WSL and lisa. Their SSH
targets default to `192.168.1.119` and `lisa`, overridden by
`ALIGNMENT_POOL_WSL_HOST` and `ALIGNMENT_POOL_LISA_HOST`. Worker HTTP URLs
default to port 3012 on those hosts; override them with
`ALIGNMENT_POOL_WSL_WORKER_URL` and `ALIGNMENT_POOL_LISA_WORKER_URL`. Give the
server SSH access to both hosts and configure the same private
`ALIGNMENT_WORKER_TOKEN` on the server and both workers. The worker's
`MEDIA_ROOT` must be writable by the SSH user, with its models under
`MEDIA_ROOT/alignment/models`. The pool copies audio into per-job directories
under that root. Pool URLs must address the remote hosts; loopback URLs are
refused for CTC. A passage-locating request has 180 seconds for staging,
scoring and cleanup together; past that its SSH/SCP processes are stopped, the
host is freed and the reader gets an error. A probe directory left by staging
that failed or ran out of time is removed under its own 30 second deadline. A
recovery that passes its deadline frees the server's lease while the worker
may still be finishing the request, the same limitation as #398; the
whole-book job (#402) removes it. Protect the worker HTTP ports on the
trusted network.

Until they are updated, the workers on WSL and lisa run their earlier revision
(`worker/` of `main` before #279), which works with this server: see "Deploying
the alignment-worker retirement (#279)" in `docs/LOCAL_CHECKS.md`. Update them
with "Updating a worker" below (#411); its `--prune` step removes Whisper,
aeneas and their weights from the hosts.

## Worker leases and staged audio

Code that needs a worker asks the pool for a **worker lease**
(`acquireWorkerLease` in `server/alignment-pool.ts`, ADR 0013). The pool tries
the configured hosts in rank order and gives the first one that is healthy,
has the work's device and precision, answers SSH and has a free slot, with the
recording's tracks staged under `MEDIA_ROOT/alignment/pool-jobs/<id>` on it.
Alignment jobs and ebook-set probes (also passage locating) use the same lease.
After a failed request, `failover` moves the lease to the next host the work has
not tried and stages the tracks there again. A job tries at most two hosts, the
first and one retry on another, however many are configured; Resume starts a
new round. A job takes a new lease on every run, so after a
server restart its stored staging is staged again.

The caller releases the lease on every exit, saying how the work ended:

- **finished** (ready, partial, failed for good, cancelled, or the job is gone):
  the job has no further use for its staging;
- **retryable** (paused, waiting in the queue because every host is busy, or
  the run was interrupted, for example by a server stop): the next run reuses
  it.

A job runner reads the outcome from the job's stored status when its run ends.
Neither outcome deletes anything on the hosts: a job's staged audio stays
there, as it did before leases. Removing it is #421, which runs inside the
server under leases. Two reviewed attempts at removing it on a finished release
showed that a remote delete can outlive the claim that protected it and reach
the folder a later run of the same job has staged into, so this change leaves
it out.

The lease records what it staged and where: a job's stored assignment keeps
every host it staged its tracks on and the folder there (`pool.stagedHosts`)
across requeues, Resume, a new plan of the same pair and server restarts. An
entry for a host that is not configured at the moment (left out of
`ALIGNMENT_POOL_HOSTS` for a while, or a retired host in a row of older code) is
kept. #421 reads this record to find the folders.

Probes always release as finished. A probe's folder is its own and nothing
reuses it, so its release removes it, as before leases.

Accepted limitations, kept as they are:

- After a recovery (passage locate) deadline the worker may still be finishing
  the request (#398, #402).
- Audio staged for a probe whose deadline fires during scoring stays on the
  host.
- A probe removal that fails or times out leaves the folder.

### Staged job audio

Job staging is not removed: it was not before leases (32 job folders on WSL on
2026-11-14), and it is not now. That audio, and what the limitations above
leave, stays on the hosts until the server removes it under leases (#421). Do not delete folders
under `pool-jobs/` by hand while jobs or probes run: a resumed or rebuilt job
reuses its folder, and a probe keeps reading its folder for the whole batch.

## Host configuration

`ALIGNMENT_POOL_HOSTS` replaces the default hosts with a JSON array, one
object per host:

```json
[
  { "id": "wsl", "sshTarget": "192.168.1.119", "workerUrl": "http://192.168.1.119:3012",
    "device": "cuda", "precision": "float16", "rank": 1, "maxConcurrent": 3 },
  { "id": "lisa", "sshTarget": "lisa", "workerUrl": "https://audiobooks.amatox.in/sonder-ctc",
    "device": "cpu", "precision": "float32", "rank": 2 }
]
```

`id`, `sshTarget`, `workerUrl`, `device` and `precision` are required; the
worker must report that device and precision on `/health`. Lower `rank` is
tried first (default: the position in the list). `maxConcurrent` (default 1)
and `remoteWorkRoot` (default `ALIGNMENT_POOL_REMOTE_ROOT`) are optional. When
the setting is unset the default is today's two hosts, built from the
`ALIGNMENT_POOL_WSL_*` and `ALIGNMENT_POOL_LISA_*` settings above, so
production needs no `.env` change. An invalid value is refused with its reason:
the image smoke fails the deploy, and the server stops at startup. No code outside the default configuration compares a host id.

## Host roles and capabilities

| Host | Device | Precision | Default URL | SSH Target & Port | Concurrency | Role |
| --- | --- | --- | --- | --- | --- | --- |
| **WSL** (`192.168.1.119`) | `cuda` | `float16` | `http://192.168.1.119:3012` | `jahn@192.168.1.119:22` | its `slots` | Primary CTC worker (NVIDIA GPU) |
| **Lisa** (`audiobooks.amatox.in`) | `cpu` | `float32` | `https://audiobooks.amatox.in/sonder-ctc` | `jahn@audiobooks.amatox.in:2269` (alias `lisa`) | its `slots` | Fallback CTC worker (CPU) |

The Steam Deck is no longer a pool host (#279): `ALIGNMENT_POOL_DECK_HOST` and
`ALIGNMENT_POOL_DECK_WORKER_URL` are ignored.

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

From a checkout of the repository on the production server, run
`scripts/install-ctc-workers.sh --host <ssh-target>`; it ships the committed
revision there (see "Updating a worker" below). On the host itself, from a
clean checkout:

For a GPU host (CUDA, e.g. WSL):
```sh
./scripts/install-ctc-workers.sh --device cuda
```

For a CPU host (e.g. Lisa):
```sh
./scripts/install-ctc-workers.sh --device cpu
```

The script performs the following actions in `$HOME/sonder-ctc-worker`:
1. Copies `worker/` of the revision to `releases/<revision>--<env>/worker/` and writes the revision beside it (`REVISION`, reported as `revision` by `/health`).
2. Creates a Python virtual environment `envs/<device>-<hash>/` for the pinned dependency set (`torch==2.8.0`, `torchaudio==2.8.0`, `numpy==1.26.4`, `fastapi==0.121.3`, `uvicorn==0.38.0`); a later revision with the same set reuses it.
3. Downloads the pinned Wav2Vec2 Base CTC checkpoint (`wav2vec2_fairseq_base_ls960_asr_ls960.pth`) into `$MEDIA_ROOT/alignment/models` (`media/` for a new host).
4. Writes `worker.env` (`ALIGNMENT_WORKER_TOKEN`, `MEDIA_ROOT`, `ALIGNMENT_CTC_DEVICE`, and `ALIGNMENT_WORKER_SLOTS` with `--slots`), mode 0600.
5. Installs, enables and starts the systemd user service `sonder-ctc-worker.service`, then verifies it (see below).

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

2. Caddy reverse-proxy block (see `deploy/ctc-worker.caddy.tmpl` or generate via `scripts/install-ctc-workers.sh --print-caddy --caddy-domain <worker-domain> --prod-ip <prod-ip>`):
   Insert this snippet into `/etc/caddy/Caddyfile` on Lisa inside the site block:

   ```caddy
   <worker-domain> {
   	handle_path /sonder-ctc/* {
   		@prod remote_ip <prod-ip>
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

   `handle_path` strips the `/sonder-ctc` prefix before forwarding to the local worker on port 3012. Replace `<worker-domain>` with the worker's domain (e.g. `audiobooks.amatox.in`) and `<prod-ip>` with the production server's public IP address (e.g. `88.91.220.114`).

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

Expected JSON response structure (WSL; the fields a worker of this revision
returns; `revision` is `null` when the code has no `REVISION` file, for example
the workers installed before #411):
```json
{
  "ready": true,
  "engine": "ctc-wav2vec2-base-960h-torchaudio-2.8-v2",
  "busy": false,
  "stuck": false,
  "busySeconds": null,
  "lastTimeout": null,
  "slots": 1,
  "activeRequests": 0,
  "mediaRoot": "/home/jahn/sonder-ctc-worker/media",
  "revision": "58e6dba1ff82586456beeb5416edf8fa8696ee1e",
  "ctc": {
    "engine": "ctc-wav2vec2-base-960h-torchaudio-2.8-v2",
    "ready": true,
    "device": "cuda",
    "precision": "float16",
    "anchorReady": true,
    "passageReady": true,
    "anchorBatch": true
  }
}
```
For Lisa (CPU), `device` will be `"cpu"` and `precision` will be `"float32"`.

## Updating a worker (#411)

Run everything from a checkout on the production server, as the owner (your
own SSH access to `192.168.1.119` and `lisa`, not the container's pool key).
`--host` ships the committed revision (`git archive` of `--ref`) to
`~/.cache/sonder-ctc-install/<revision>/` on the host and runs the installer
there, so the host needs no checkout. Do one host at a time, WSL first.

1. **Stop new work.** On the Activity page, pause the alignment processor and
   wait until no request runs (`activeRequests` 0, `busy` and `stuck` false):

   ```sh
   curl -s http://192.168.1.119:3012/health | jq '{activeRequests, busy, stuck, revision}'
   ```

2. **Dry run.** It reads the host and prints the plan; it changes nothing on
   the host except the shipped copy in `~/.cache/sonder-ctc-install/`:

   ```sh
   git fetch origin
   scripts/install-ctc-workers.sh --host 192.168.1.119 --ref origin/main --dry-run
   ```

   Check that it says "The worker runs no request", names the revision it will
   install and the installed one (`unknown` for a worker from before #411),
   whether it builds a new environment (the first update on WSL downloads the
   CUDA wheels, about 3 GB), and lists every `worker.env` key as `kept` (only
   the keys you change with `--device`, `--slots` or a new token show
   `changed`). The unit diff shows the switch to `releases/` and `envs/`.

3. **Update.** The same command without `--dry-run`:

   ```sh
   scripts/install-ctc-workers.sh --host 192.168.1.119 --ref origin/main
   ```

   In order, it:
   - refuses (exit 3) while `/health` shows a running request, a busy or stuck
     worker, or cannot be read or understood; `--force` is the only way past,
     and interrupts whatever runs;
   - copies the code to a new `releases/<revision>--<env>/` and builds or
     reuses `envs/<env>/`, downloads the model into the `MEDIA_ROOT` the
     worker uses (read as systemd reads `worker.env`: quotes, CRLF), without
     touching the code, packages or settings of the running worker;
   - writes `worker.env` keeping every line it does not set, saves the current
     `worker.env`, unit and release in `rollback/`, checks `/health` once
     more, switches unit, `worker.env` and `current`, and restarts the service
     once;
   - verifies, for up to `--verify-timeout` seconds (default 300): `ready`,
     `ctc.engine` of this revision, `ctc.ready`, the device, `mediaRoot`, and
     `revision` equal to the installed revision, then sends one authenticated
     request (an `/anchor-batch` for audio that does not exist: the worker's
     token check must pass, so it answers 400, not 401).

   Exit 0 means verified. Check it from here too:

   ```sh
   curl -s http://192.168.1.119:3012/health | jq '{revision, engine, ctc}'
   ```

4. **If it exits 4** (verification failed, or systemctl failed after the
   switch), roll back:

   ```sh
   scripts/install-ctc-workers.sh --host 192.168.1.119 --rollback --dry-run
   scripts/install-ctc-workers.sh --host 192.168.1.119 --rollback
   ```

   It restores the saved `worker.env`, the unit and the previous code, restarts
   once and waits until the previous worker reports ready (and its revision,
   when it had one). It refuses while the new worker runs requests, like the
   update; `--force` interrupts them. Until you roll back or verify, a new
   update refuses: when the worker only needed longer to load, run `--verify`,
   which checks again and restarts nothing. `journalctl --user -u
   sonder-ctc-worker.service` on the host shows why a worker did not start.

5. **lisa**: steps 1 to 4 with `--host lisa` and
   `curl -s https://audiobooks.amatox.in/sonder-ctc/health` (only the production
   server may read it). Then resume the alignment processor.

6. **Prune**, once both hosts are verified and you no longer want to roll
   back. Dry run first:

   ```sh
   scripts/install-ctc-workers.sh --host 192.168.1.119 --prune --dry-run
   scripts/install-ctc-workers.sh --host 192.168.1.119 --prune
   ```

   It removes the layout from before #411 (`worker/` with the retired Whisper
   and aeneas files, and `env/` with `faster-whisper` and aeneas), older
   releases and environments, `MEDIA_ROOT/alignment/models/whisper`, and
   `rollback/`, then reports whether the installed environment has
   `faster_whisper` or `aeneas` (a new environment has neither). It runs only
   after a verified update and when the unit runs the installed release, and
   restarts nothing. After it, `--rollback` has nothing to restore.

Exit codes: 0 done, 1 error, 2 usage, 3 refused (requests running, `/health`
unknown, last update not verified, a second run in progress, or `systemctl
--user` unreachable is 1), 4 verification failed.

Layout on the host after an update:

```text
~/sonder-ctc-worker/
├── worker.env                      # settings, mode 0600
├── current -> releases/<revision>--<env>
├── releases/<revision>--<env>/worker/   # code, with REVISION
├── releases/<revision>--<env>/env -> ../../envs/<env>
├── envs/<device>-<hash>/           # one per dependency set; never changed once complete
├── rollback/                       # worker.env, unit, current, previous-revision, revision, status
├── worker/, env/                   # the layout from before #411, until --prune
└── media/                          # the default MEDIA_ROOT of a new host
```

The unit names the release and environment by their real paths, so switching
`current` or adding a release never changes what a running worker imports.
Accepted limitations: between the last `/health` check and the restart there
is a window of milliseconds in which the server can send a request; a job the
server is still staging when the worker restarts fails like any request to a
restarting worker and runs again on the other host or waits (pausing the
alignment processor first avoids both). With `--skip-service` nothing is
restarted or verified: restart the worker yourself, then run `--verify`.

The tests run the whole procedure against a fake host (temporary directories,
host steps replaced, a fake worker on a free local port):
`tests/install-ctc-workers-update.test.mjs` and
`tests/ctc-worker-install-helper.test.mjs`. In that test mode the installer
has no default directory or worker URL, and a host step a test did not replace
refuses instead of reaching a host.

## Overlapped audio extraction (#346)

Each `/align` request for the CTC engine may carry `prefetch`: the next sections of the same job (`audio`, `start`, `duration`). The worker extracts those windows in a thread pool of parallel ffmpeg processes while the current section encodes, and `align_ctc_section` takes the finished WAV instead of decoding inline. A window that is missing, late or failed is extracted inline as before, so results do not depend on it. Workers without the field ignore it.

- `ALIGNMENT_PREFETCH_SECTIONS` (server, 0 to 16, default 6): how many upcoming sections each request names. `0` turns it off.
- `ALIGNMENT_EXTRACT_WORKERS` (worker, 1 to 16): parallel ffmpeg processes. Default: `min(6, cpus - 2)` when `ALIGNMENT_CTC_DEVICE` is `cuda`, otherwise 1. On a CPU host decoding is about 1% of the encode time, so overlapping it gains little and the cores stay with the encoder.
- `stageTimings.extractionPrefetched` is 1 for a section whose audio was already extracted, so `audioExtraction` then measures only the wait.
- Prefetched files live in `alignment/ctc-prefetch/`, at most 32 at a time; files older than one hour are removed on first use.

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

## Qualification, 2026-11-14 (#279)

The gate was run again after Whisper and aeneas were removed, on the worker
files of this change (`align.py`, `ctc_*.py`, `deadline.py`,
`download_model.py`, `gate_ctc.py`; SHA-256 checked against the branch). Each
host ran a temporary worker from `~/sonder-replication/retire-279/` on port
43279, with its own media root, the pinned checkpoint linked read-only from the
installed worker, the installed worker's Python environment (read-only) and
`slots` 1. The input was the same 128-utterance labelled sample
(`alignment-labelled-20261106-7tasSF/inputs/`, the same SHA-256 on both hosts).
Both workers reported engine `ctc-wav2vec2-base-960h-torchaudio-2.8-v2` at the
top level of `/health` and under `ctc`.

| Metric | WSL GPU (cuda, float16) | lisa CPU (cpu, float32) | Required |
| --- | ---: | ---: | ---: |
| Covered utterances | 128/128 | 128/128 | 128/128 |
| Both sentence endpoints ≤250 ms | 128/128 | 128/128 | 128/128 |
| Transition midpoints ≤250 ms | 127/127 | 127/127 | 127/127 |
| Missing utterances | 0 | 0 | 0 |
| Maximum endpoint or transition error | 194.3 ms | 194.3 ms | ≤1000 ms |
| First sentence located and kept | yes | yes | yes |
| Last sentence located and kept | yes | yes | yes |
| Unrelated chapter left unsynced | yes | yes | yes |
| Gate run (health to report) | about 12 s | about 94 s | — |

Gate: PASS on both hosts; outcome `mapped`. CPU and GPU give the same outcomes.

## Probing gate (#278)

The one-off CTC and Whisper probing comparison passed for all eight titles; the results are recorded in [PR #375](https://github.com/jahnzh/sonder/pull/375). The comparison scripts and Whisper prober have been retired.

## Implementation evidence

| Proposal | Evidence |
| --- | --- |
| Route CTC to WSL first and lisa as the only fallback; never send it to production. | `tests/alignment-ctc.test.ts`: unreachable, busy or incompatible WSL; legacy assignment; disabled pool; and cross-host retry tests. `tests/alignment-pool.test.ts`: production URL rejection, SSH diagnostics and staging tests. |
| Hand out worker leases: first healthy host by rank, fallback when down or full, re-staging after a worker or server restart, release on every exit, staged audio removed on a finished release only (#394). | `tests/alignment-worker-lease.test.ts` (in-process fake hosts, `tests/fake-pool-host.ts`); host configuration in `tests/alignment-pool-hosts.test.ts`. |
| Use reported device and busy state for capability and capacity. | `tests/alignment-ctc.test.ts`: incompatible or busy WSL and both workers busy. Real `/health` responses identified WSL as CUDA float16 and lisa as CPU float32 before the gates. |
| Retry a failure once on the other host, retain a retryable failure, and keep CPU and GPU in the same engine generation with device and precision for diagnostics. | `tests/alignment-ctc.test.ts`: cross-host retry and manual Resume, anchored-window failover, and the CPU and GPU metadata assertions. |
| Install the lisa environment with the pinned CPU wheels and the anchored planner dependency; document the commands. | The commands above completed on lisa; its environment imported Torch and TorchAudio `2.8.0+cpu`, FastAPI `0.121.3`, Uvicorn `0.38.0`. |
| Run both real-model gates and report their outcomes. | The two tables above show identical passing results. |
| Reproducible install script (`scripts/install-ctc-workers.sh`), systemd user service unit template (`deploy/ctc-worker.service.tmpl`), Caddy reverse-proxy snippet template (`deploy/ctc-worker.caddy.tmpl`), and documentation runbook. | `tests/install-ctc-workers.test.mjs` verifying installer CLI, help flag, syntax, service template, and Caddy configuration. |
| Safe update (#411): keep `worker.env`, refuse while busy or unknown, no mixed code, one restart, verification with the revision, rollback, prune of Whisper and aeneas. | `tests/install-ctc-workers-update.test.mjs` (fake host), `tests/ctc-worker-install-helper.test.mjs` (systemd 255 parsing sample), `tests/worker/test_health_revision.py`. |

The pool remains off by default. No schema migration is needed. The worker
ran `npx tsc --noEmit`, the focused alignment tests, `npm test`, and the Python
worker tests; the coordinator runs `npm run check -- --ref <commit>` on the
committed revision.
