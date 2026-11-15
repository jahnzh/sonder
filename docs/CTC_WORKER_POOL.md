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
`.env` is ignored. The SSH
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

The workers on WSL and lisa keep running their current revision (`worker/` of
`main` before #279), which works with this server: see "Deploying the
alignment-worker retirement (#279)" in `docs/LOCAL_CHECKS.md`. Updating them is
#411; do not run the installer below for the #279 deploy.

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
4. Installs pinned dependencies (`torch==2.8.0`, `torchaudio==2.8.0`, `numpy==1.26.4`, `fastapi==0.121.3`, `uvicorn==0.38.0`).
5. Downloads the pinned Wav2Vec2 Base CTC checkpoint (`wav2vec2_fairseq_base_ls960_asr_ls960.pth`) into `$MEDIA_ROOT/alignment/models`.
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
returns):
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

## Whole-book jobs (#402)

ADR 0016's whole-book request, on the worker only: the server does not call it
yet. The window endpoints (`/align`, `/anchor`, `/anchor-batch`) and their
engine `ctc-wav2vec2-base-960h-torchaudio-2.8-v2` are unchanged. A whole-book
job is a new engine generation, `ctc-wav2vec2-base-960h-torchaudio-2.8-book-v1`
(`book_job.BOOK_ENGINE`), with the same model. `/health` reports it under
`bookJobs: {engine, ready, jobs}`.

Code: `worker/book_job.py` (lifecycle, stages, resume), `book_session.py`
(per-book session, #391), `book_audio.py` (decode), `book_encode.py`
(encode and encode queue), `book_align.py` (aligner). `gate_book.py` and
`measure_book.py` are measurement scripts. They talk to a worker over this
interface and are not copied into the image.

### Endpoints

Every request carries `Authorization: Bearer <ALIGNMENT_WORKER_TOKEN>`; a
missing or wrong token is `401`.

| Request | Answer |
| --- | --- |
| `POST /book-jobs` with the start request | `202` and the progress. The same `jobId` with the same request returns the existing job and does not run it again. The same `jobId` with another request is `409`. A track outside `MEDIA_ROOT` or missing is `400`. A missing media volume is `503`. |
| `GET /book-jobs/{jobId}` | `200` and the progress; `404` for an unknown job |
| `DELETE /book-jobs/{jobId}` | `200` `{jobId, engine, state: "cancelled"}`. The job stops and its folder is deleted. Later requests for it answer `404`. |
| `GET /book-jobs/{jobId}/result` | `200` and the result once `state` is `done`. Before that, `409` `{jobId, engine, state, message}`. |

### Start request

```json
{
  "jobId": "4f0c…",                      // [A-Za-z0-9][A-Za-z0-9._-]{0,127}
  "recordingId": "recording-torbox-129969003",
  "audioFingerprint": "…",               // optional, part of the job's identity
  "language": "eng",                     // anything else: outcome language_not_supported
  "sentences": [{"id": "5:8", "section": 5, "text": "…"}],   // 1..200,000, in reading order
  "tracks": [{"id": "torbox-129969003-1", "audio": "/…/pool-jobs/<job>/tracks/torbox-129969003-1",
              "duration": 36458.949}]   // in play order; duration = listed seconds (> 0)
}
```

The job's identity is a hash of `recordingId`, `audioFingerprint`,
`language`, `sentences` and `tracks`. `duration` sizes the disk reservation;
the worker probes the container duration itself.

### Progress

```json
{"jobId": "m-lhod-1794710439", "engine": "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v1",
 "state": "encoding", "recordingId": "lhod", "createdAt": 1794710439.83, "updatedAt": 1794710473.52,
 "progress": {"tracksTotal": 1, "tracksDecoded": 1, "tracksEncoded": 0, "encodeQueuePosition": 0},
 "stageTimings": {"identity": 0.39, "decode": 33.29, "encodeQueue": 0.00004},
 "error": null, "resumed": 0}
```

`state` goes `queued` (waiting for the disk budget) → `decoding` → `encoding` →
`anchoring` → `aligning` → `finishing` → `done`, or ends in `failed` (with
`error`) or `cancelled`. `progress` grows as the job goes on:
`tracksTotal`, `tracksDecoded`, `tracksEncoded`; `encodeQueuePosition` while
encoding (`0` encoding, `1…` waiting); then `groupsTotal`, `groupsDone` and
`anchors` (`candidates`, `chain`, `chainRateDropped`, `groups`,
`anchorSeconds`). `stageTimings` holds seconds per stage (`identity`, `decode`,
`encodeQueue`, `encode`, `prepare`, `anchor`, `align`, `finish`). After a
result fetch, `fetched` is `true`. `resumed` counts the worker restarts the job
has continued from. `encode` holds the encode statistics (`encodeSeconds`,
`audioSeconds`, `realtime`, `batch`, `oomHalvings`, `gpuUtilization`).

### Result

```json
{"jobId": "…", "engine": "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v1", "recordingId": "…",
 "audioFingerprint": "…", "outcome": "mapped", "sentences": 5771, "mapped": 5460,
 "intervals": [{"paragraphId": "5:8", "section": 5, "trackId": "torbox-129969003-1",
                "start": 715.32, "end": 719.9, "confidence": 0.65}],
 "tracks": [{"id": "torbox-129969003-1", "decodedSeconds": 36458.967, "containerSeconds": 36458.949,
             "differenceSeconds": 0.018, "durationOk": true, "ranges": 21}],
 "stats": {"groups": 49, "groupStartsSeconds": [0, 960.0], "anchors": {…}, "windows": 0,
           "recoveries_text": 0, "recoveries_audio": 0, "gap_filled": 0, "orderConflictsDropped": 0,
           "rawMapped": 0, "kernel": "numba", "device": "cuda"},
 "stageTimings": {…}, "encode": {…}}
```

`intervals` has the server's `AlignmentInterval` shape. `start` and `end` are
seconds in the track's own time, on the container timeline. `confidence` follows
the server's rule: 0.65 for 0.3 to 6 words per second, else 0.2. `outcome` is
`mapped` when at least one sentence is mapped and `unsynced` when none is.
For a language other than `eng` it is `language_not_supported`; the server
judges coverage. `tracks` is the per-track duration check: the decoded length
against the container duration (ffprobe), `durationOk` within 0.25 s.
Unsynced passages, extra-audio flags and the text-match check are not built
yet (next ticket).

### What the worker does

* **Decode on the container timeline.** ffmpeg decodes with
  `aresample=async=1:min_hard_comp=0.01:first_pts=0`, so samples are placed by
  the packets' timestamps, not counted. *The Left Hand of Darkness* (AAC in MP4)
  has 21 chapter joins whose timestamps overlap by about 64 ms each. Decoded by
  sample count it is 36,460.25 s long; on its timeline 36,458.97 s; its
  container says 36,458.95 s.
* **Parallel decode.** A track longer than 1,800 s is split into equal time
  ranges, each decoded by its own ffmpeg (`-ss`/`-t`, which seek by timestamp)
  and cut or padded to its exact sample count. All ranges of all tracks share
  `ALIGNMENT_BOOK_DECODE_WORKERS` processes (default CPUs − 1, at most 8).
* **One continuous encode.** The windows of all tracks (each track on its own
  grid: 20 s cores, 5 s context) form one stream. Consecutive windows of equal
  length are batched, `ALIGNMENT_BOOK_ENCODE_BATCH` (default 8), with no padding.
  Each track's emissions (float16, 29 labels) go to their own file. A track's
  PCM is deleted once its emissions are written.
* **One encode per GPU.** Jobs enter a first-come queue per device before
  encoding. Decoding and aligning of other books run beside it. The window
  endpoints do not use the queue.
* **The aligner** is the v2 anchor chain of `PROTO-D-E-BOOKS.md`, unchanged in
  its parameters (δ 1.5, skip 8, 60 s windows, 20 s margin, text × 1.3) and its
  four chain constants (locate every 240 s, groups ≥ 600 s, rate floor 0.25).
  It locates the text over the whole book, keeps the longest chain rising in
  audio and text, and aligns the groups in a process pool
  (`ALIGNMENT_BOOK_ALIGN_WORKERS`, default CPUs − 2, at most 8). A recovery jump
  stays inside its group. The worker's `accepted_intervals` then validates the
  merged map.
* **Seam fix.** A group's audio runs 60 s (v2: 30 s) past the next group's start.
  Before merging, the last 20 s of a non-final group and the first 20 s of a
  non-first group are dropped: the same margin a window keeps uncommitted. A
  sentence cut by a group end therefore comes from the neighbouring group,
  where it is whole.
* **Viterbi kernel.** numba when installed (the pool hosts' production
  environments do not have it), otherwise an equivalent numpy kernel.
  `tests/worker/test_book_align.py` checks that the two give identical paths.
  `stats.kernel` says which one ran.

### Session, disk budget and resume

Each job has one per-book session (#391), keyed by the job. The session owns the
decoded audio, the tracks' digests, the emissions handle and the process pool.
It ends exactly once:

* when the result is fetched (decoded audio, emissions and pool go; the small
  `result.json` stays fetchable);
* on cancel (the whole folder goes);
* after `ALIGNMENT_BOOK_IDLE_SECONDS` (default 900) without a request for the job
  from the server, which also stops a running job and deletes its folder;
* on worker stop, when the folder is kept.

Locks are taken in the order `BookJobs` → session registry → session → disk
budget, and `Job.save_lock` before `Job.lock`. No lock is held while waiting
for the encode queue, a process or book I/O.

One disk budget per worker, `ALIGNMENT_BOOK_DISK_BYTES` (default 64 GiB), covers
decoded audio and emissions together. A job reserves its estimate before
decoding: listed duration × (32,000 B/s PCM + 5,800 B/s emissions) + 5 %. A book
that does not fit next to the other sessions waits in `queued`. A book larger
than the whole budget fails at once.

Everything is kept under `MEDIA_ROOT/alignment/book-jobs/<jobId>/`:
`request.json`, `state.json`, `tracks/` (PCM), `emissions/<n>.f16` + `<n>.json`
(per track, with engine and source sha256), `emissions/book.f16`,
`groups/plan.json` and `groups/<n>.json` (one per finished group),
`result.json`. Groups are the unit of progress and resume. When the worker
starts, every unfinished job continues. Tracks whose emissions match their
source digest are not decoded or encoded again; the stored plan and finished
groups are reused. A track whose bytes changed is decoded and encoded again. A
job folder written by another engine generation starts over.

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
| Use reported device and busy state for capability and capacity. | `tests/alignment-ctc.test.ts`: incompatible or busy WSL and both workers busy. Real `/health` responses identified WSL as CUDA float16 and lisa as CPU float32 before the gates. |
| Retry a failure once on the other host, retain a retryable failure, and keep CPU and GPU in the same engine generation with device and precision for diagnostics. | `tests/alignment-ctc.test.ts`: cross-host retry and manual Resume, anchored-window failover, and the CPU and GPU metadata assertions. |
| Install the lisa environment with the pinned CPU wheels and the anchored planner dependency; document the commands. | The commands above completed on lisa; its environment imported Torch and TorchAudio `2.8.0+cpu`, FastAPI `0.121.3`, Uvicorn `0.38.0`. |
| Run both real-model gates and report their outcomes. | The two tables above show identical passing results. |
| Reproducible install script (`scripts/install-ctc-workers.sh`), systemd user service unit template (`deploy/ctc-worker.service.tmpl`), Caddy reverse-proxy snippet template (`deploy/ctc-worker.caddy.tmpl`), and documentation runbook. | `tests/install-ctc-workers.test.mjs` verifying installer CLI, help flag, syntax, service template, and Caddy configuration. |

The pool remains off by default. No schema migration is needed. The worker
ran `npx tsc --noEmit`, the focused alignment tests, `npm test`, and the Python
worker tests; the coordinator runs `npm run check -- --ref <commit>` on the
committed revision.
