# CTC worker pool

All alignment work runs on these pool hosts only: alignment maps, ebook
candidate probing and passage locating (**Back to narration** without a map). The production
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

The workers on WSL and lisa keep running their current revision (`worker/` of
`main` before #279), which works with this server: see "Deploying the
alignment-worker retirement (#279)" in `docs/LOCAL_CHECKS.md`. Updating them is
#411; do not run the installer below for the #279 deploy.

## Worker leases and staged audio

Code that needs a worker asks the pool for a **worker lease**
(`acquireWorkerLease` in `server/alignment-pool.ts`, ADR 0013). The pool tries
the configured hosts in rank order and gives the first one that is healthy,
has the work's device and precision, answers SSH and has a free slot, with the
recording's tracks staged under `MEDIA_ROOT/alignment/pool-jobs/<id>` on it
(`<id>.r1`, `<id>.r2`, … once the sweep below has retired the plain name).
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
there until the sweep below removes it. Two reviewed attempts at removing it on
a finished release showed that a remote delete can outlive the claim that
protected it and reach the folder a later run of the same job has staged into.

The lease records what it staged and where: a job's stored assignment keeps
every host it staged its tracks on and the folder there (`pool.stagedHosts`)
across requeues, Resume, a new plan of the same pair and server restarts. An
entry for a host that is not configured at the moment (left out of
`ALIGNMENT_POOL_HOSTS` for a while, or a retired host in a row of older code) is
kept. The sweep reads this record to find the folders. Deleting a job row
keeps where it staged (`alignment_pool_orphans`).

Probes always release as finished. A probe's folder is its own and nothing
reuses it, so its release removes it, as before leases.

Accepted limitations, kept as they are:

- After a recovery (passage locate) deadline the worker may still be finishing
  the request (#398, #402).
- Audio staged for a probe whose deadline fires during scoring stays on the
  host.
- A probe removal that fails or times out leaves the folder.

### Removing staged job audio (#421)

Staged job audio, from before leases (32 job folders on WSL on 2026-11-14) and
after, is removed by the administrator's sweep inside the server
(`server/alignment-pool-sweep.ts`). Run the dry run first:

- `GET /api/alignments/pool/staging` (admin only; `?host=<id>` for one host)
  lists, per configured host, the worker's media root and the real paths of
  that root and of its `alignment/pool-jobs` folder (`realRoot`,
  `realPoolJobs`: symlinks resolved on the host), every entry under
  `alignment/pool-jobs` with its size (`du -sk`, KiB), the job and status the
  server records for it, and what a run would do now: **remove** (its
  job is finished, ready, partial, failed or cancelled, or the job was
  deleted, or the name was retired by an earlier run), **keep** (the job is
  queued, copying, processing or paused, a lease holds the folder, the
  recording's lease is held by any job or probe, or a run of the job is in
  flight between its leases: the same checks the run makes) or **unknown**
  (the server has no record of it). Each host also reports `removableKiB`,
  the size of the folders marked remove. A host that cannot be reached
  reports its error and lists nothing. Every configured host is listed, also
  for `?host=`, because of the refusal below.
- **Refusal.** A run removes nothing on any host unless every configured host
  was listed without an error in that run and no host's real media root or
  real pool-jobs folder lies strictly inside another host's (or its own) real
  pool-jobs folder: `rm -rf` of a job folder on one host would otherwise
  remove what a worker whose root is inside it stages. Two hosts with the same
  real pool-jobs folder are allowed (different machines often use the same
  path; one shared folder is covered by the global retired names). The dry
  run and the run report the reason as `refused` on every host, and a
  refused dry run marks nothing remove and counts nothing removable. Fix the
  host (bring it up) or the configuration (`ALIGNMENT_POOL_HOSTS`, the
  workers' `MEDIA_ROOT`) and run the dry run again.
- `POST /api/alignments/pool/staging/remove` (admin only; an empty body, or
  `{"host": "<id>"}`) lists again and removes each folder marked remove, one at
  a time per host. One run at a time; a second gets 409. Each folder's result
  is `removed`, `kept` (with the reason it was found in use when checked
  again) or `failed` (the removal failed or passed its 60 s deadline; the
  name stays retired and a later run removes the folder).

How a removal stays away from live work: the sweep takes the recording's lease
(no job or probe of the recording can take a host meanwhile), then, in one
write transaction, reads the job's row again, checks that no lease and no run of
the job is live in this server, and retires the folder's name
(`alignment_pool_retired`). Only then is `rm -rf -- <folder>` sent. Staging
chooses its folder name after leasing the host and the recording and never
uses a retired name, so a later run of the same job stages under `<id>.r1`, and
a removal that is still running after its deadline, after a server restart or
on a slow host can only reach a folder nothing stages into again.

What the real paths cannot see: a worker root that is physically inside
another host's pool-jobs folder without the resolved paths showing it, such
as a bind mount, or one network share mounted at unrelated paths on two
machines (or reached as two host entries). Configure each worker's
`MEDIA_ROOT` on its own disk or folder, never inside or mounted from another
worker's `alignment/pool-jobs` (`scripts/install-ctc-workers.sh` sets each
worker's `MEDIA_ROOT` to `<its install directory>/media` on its own host).

Unknown folders are never removed by this version: folders whose job row no
longer records them (staged before `pool.stagedHosts` existed and since
cleared, or of a job deleted before #421), probe folders of probes that ended in
an earlier server process (nothing records probes), files, symlinks and names
the pool does not make. Do not delete folders under `pool-jobs/` by hand while
jobs or probes run: a resumed or rebuilt job reuses its folder, and a probe
keeps reading its folder for the whole batch.

**Leftover probe folders (a known limit).** A probe interrupted before its own
cleanup (a server restart, a failed removal) leaves a `ctc-probe-<uuid>`
folder that the sweep lists as unknown for good: nothing durable records
probe stagings, and this version does not add such a record. A probe folder
is listed as keep while its probe runs in this server; probe ids are random
and never reused, so a `ctc-probe-<uuid>` folder the dry run lists as
**unknown** belongs to a probe that has ended and nothing stages into it
again. The administrator removes such a folder by hand on its host, by the
path the dry run prints (`rm -rf -- '<path>'`), right after a dry run that
shows it unknown and reports no `refused` on any host, while one server
process uses the pool. Do not do this for other unknown folders: a job
folder without a record may still belong to a job.

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
- **Book model** (#921): `ALIGNMENT_BOOK_MODEL` in a host's `worker.env`, `wav2vec2-base` or `sew-d-tiny`; unset, a `cuda` host keeps Wav2Vec2 Base and any other takes SEW-D tiny. So WSL encodes whole books with Base and lisa with SEW-D tiny; window requests use Base on both. An unknown value stops the worker at start. `scripts/install-ctc-workers.sh --book-model <name>` writes it (and keeps it on a reinstall).
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
  "revision": "c901429f0e2d3c4b5a69788796a5b4c3d2e1f0a9",
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
A worker of this revision also returns `bookJobs` (see "Whole-book jobs").

### 6. Code version, restart and disable from the Activity page (#357)

**Code version.** `/health` reports `revision`, read once at startup from a
file `REVISION` beside the worker's code (`~/sonder-ctc-worker/worker/REVISION`);
a missing, empty or unreadable file (any error while reading it, a memory error
too) is reported as `null` and shown as "unknown", and never stops the worker.
At most the first 256 bytes are read. Only the first line is used, cut to 64
characters of `A-Z a-z 0-9 . _ + / @ : -`. The hosts are updated by hand by
copying `worker/`; **the copy writes the commit into `REVISION`**, then
restarts the service. From a checkout of the commit to install, per host:

```sh
rev=$(git rev-parse HEAD)
rsync -a --exclude __pycache__ worker/ 192.168.1.119:sonder-ctc-worker/worker/
ssh 192.168.1.119 "echo $rev > ~/sonder-ctc-worker/worker/REVISION && systemctl --user restart sonder-ctc-worker.service"
rsync -a -e 'ssh -p 2269' --exclude __pycache__ worker/ jahn@audiobooks.amatox.in:sonder-ctc-worker/worker/
ssh -p 2269 jahn@audiobooks.amatox.in "echo $rev > ~/sonder-ctc-worker/worker/REVISION && systemctl --user restart sonder-ctc-worker.service"
curl -s http://192.168.1.119:3012/health | jq -r .revision   # the commit
```

`worker/REVISION` is git-ignored, so a copy made in a checkout is never committed.

`scripts/update-ctc-workers.sh <commit>` does the same copy as one command. It skips a host
whose commit has the same `worker/` as the wanted one, so after a merge that leaves
`worker/` alone the hosts keep reporting the older commit: `revision` is the commit the
worker code was last copied from, not always the newest commit on `main`.

**Restart.** The worker's page (Activity › Server, `#activity/server/<worker>`, #520) restarts a host's worker with one fixed
command over the pool's SSH connection, `systemctl --user restart
sonder-ctc-worker.service` (`RESTART_TARGETS` in
`server/alignment-host-control.ts`, ADR 0002); the request names only the host.
It is refused while `/health` reports window requests (or every slot busy),
whole-book jobs, an encode or a resume, while the server holds a lease on the
host, or when `/health` cannot be read or understood, unless the administrator
forces it. For this decision `/health` is read strictly: it must be a JSON
object whose `activeRequests` is a non-negative integer and `busy` and `stuck`
are booleans, and when `bookJobs` is present its `jobs` and `slotsHeld` are
non-negative integers, `resuming` a boolean and `stuck` a list; anything else
is refused as "cannot be understood" (lease dispatch reads `/health` as
before). An unforced restart holds the host from the moment its check passes
until it has finished (ready again, or failed and reported): no lease is given
on that host meanwhile, so new work goes to the other host or waits, as for a
busy host. The check and the hold are one step, and the hold ends on every exit.
The server then
waits up to 120 s for `/health` to answer ready (the same check a lease uses)
and shows the result on the host's row. The pool key is not restricted to that
command on the hosts: it also runs the staging commands, so the allowlist is the
server's fixed list.

**Disable.** A disabled host (settings key `activityHostDisabled:<host id>`)
is skipped by every lease (`takeHost` in `server/alignment-pool.ts`): no new
alignment job, probe or whole-book job goes there, it is not counted as a tried
host, and a whole-book job goes to the CPU host as when the GPU host cannot be
used. The switch is read again at the moment the lease is taken, after the
host's health check and SSH probe, so a host disabled during either is not
leased. The one exception is the host a whole-book job was started on, taken
back without staging after a server restart: the worker's job there is polled
and finishes. If that worker no longer has the job (404) or the start never
reached it, the job is not started again on the disabled host: it moves to
another host, without counting the disabled one as tried, or waits in the queue
with the reason in its pool errors. With every host disabled, new work waits as
when every host is busy. The staging sweep (#421) still lists and removes staged
folders on a disabled host, on purpose: cleaning a host taken out of use is wanted.

## Whole-book jobs (#402)

ADR 0016's whole-book request. The server calls it only with
`ALIGNMENT_BOOK_JOBS=1` (#404, off by default; see "The server's whole-book
runner" below). The window endpoints (`/align`, `/anchor`, `/anchor-batch`) and their
engine `ctc-wav2vec2-base-960h-torchaudio-2.8-v2` are unchanged. A whole-book
job is a new engine generation, `ctc-wav2vec2-base-960h-torchaudio-2.8-book-v2`
(`book_job.BOOK_ENGINE`), with the same model. Since #921 a CPU host encodes whole books
with SEW-D tiny instead, under its own engine
`ctc-sew-d-tiny-100k-ft-ls100h-transformers-4.56-book-v2`, the same generation
(see "SEW-D tiny for whole-book jobs on CPU hosts" below). `book-v1` was #402's; #403 made
`book-v2` because its maps hold more than v1's could (the leftover pass maps
chapters read out of the ebook's order, and a wrong book ends as
`text_mismatch`), so a map's content depends on the generation. A retained job
folder of `book-v1` starts over, emissions included (their identity carries the
engine), and so does one of the other book model's engine. `/health`'s existing fields
(`busy`, `busySeconds`, `activeRequests`, `slots`, `stuck`) describe window
requests only, exactly as before; book work is reported only under
`bookJobs: {engine, model, ready, jobs, resuming, slotsHeld, batchSeconds, stuck,
diskReservedBytes, diskBudgetBytes}`: `engine` and `model` (`wav2vec2-base` or
`sew-d-tiny`) are the host's book model's, and `ready` also needs that model's
weights (and for SEW-D tiny the pinned transformers). `resuming` is `true` while the worker
still picks up its retained job folders after a start (book requests get
`503` until then). `slotsHeld` is the number of the
worker's slots that encode batches hold at that moment and `batchSeconds` the
age of the oldest (see "Shared GPU"); `stuck` lists the jobs whose session is
kept because a process is still there or files of its folder could not be
deleted (`jobId`, `reason`, `since`, `reservedBytes`, see "Session, disk
budget and resume").

Code: `worker/book_job.py` (lifecycle, stages, resume), `book_session.py`
(per-book session, #391), `book_audio.py` (decode), `book_encode.py`
(encode and encode queue), `book_align.py` (aligner and leftover pass),
`book_match.py` (text-match check), `book_report.py` (unsynced passages and
flags). `gate_book.py` and
`measure_book.py` are measurement scripts. They talk to a worker over this
interface and are not copied into the image.

### Endpoints

Every request carries `Authorization: Bearer <ALIGNMENT_WORKER_TOKEN>`; a
missing or wrong token is `401`. For `POST /book-jobs` the token is checked
before any of the body is read. A body larger than 32 MiB
(`align.BOOK_REQUEST_MAX_BYTES`) is `413`: refused unread when its
`Content-Length` says so, and cut off at the limit when it is sent chunked.
The largest request of the 2026-11-14 set is 7.8 MB (the complete works in
the *Dorian Gray* ebook, 71,225 sentences; the 33 h book's is 2.9 MB), so the
limit is four times that, about a request at the 200,000-sentence limit of
that book's average sentence length. A body that is not a valid start request
is `422`.

Trust model: the worker trusts whoever holds the token. There is one server
and one token per worker, so any holder of the token can read the progress
and the result of any job and cancel it; jobs are not owned by a caller. This
is the same model as the window endpoints.

| Request | Answer |
| --- | --- |
| `POST /book-jobs` with the start request | `202` and the progress. The same `jobId` with the same request returns the existing job and does not run it again. The same `jobId` with another request, or one whose cancelled job is still stopping, is `409`. A track outside `MEDIA_ROOT` or missing is `400`. A missing media volume is `503`. A request whose files do not fit the disk budget next to the other jobs is `507`, before anything is written. While the worker still picks up its retained jobs after a start (`bookJobs.resuming`), this and the three requests below are `503` with that reason; retry shortly. |
| `GET /book-jobs/{jobId}` | `200` and the progress; `404` for an unknown job |
| `DELETE /book-jobs/{jobId}` | `200` `{jobId, engine, state: "cancelled"}`. The job stops and its folder is deleted. Later requests for it answer `404`. |
| `GET /book-jobs/{jobId}/result` | `200` and the result once `state` is `done`. Before that, `409` `{jobId, engine, state, message}`. The fetch ends the job: its folder is deleted with its reservation, and later requests for it answer `404`. |

### Start request

```json
{
  "jobId": "4f0c…",                      // [A-Za-z0-9][A-Za-z0-9._-]{0,127}
  "recordingId": "recording-torbox-129969003",
  "audioFingerprint": "…",               // optional, part of the job's identity
  "language": "eng",                     // anything else: outcome language_not_supported
  "sentences": [{"id": "5:8", "section": 5, "text": "…"}],   // 1..200,000, in reading order
  "tracks": [{"id": "torbox-129969003-1", "audio": "/…/pool-jobs/<job>/tracks/torbox-129969003-1",
              "duration": 36458.949}],  // in play order; duration = listed seconds (> 0)
  "sections": [{"index": 5, "title": "Introduction"}]   // optional: titles for passages and flags
}
```

The job's identity is a hash of `recordingId`, `audioFingerprint`,
`language`, `sentences`, `tracks` and `sections`. `sections` (the server's
`book.sections[].index` and `.title`) is optional; without it the result's
unsynced passages have the title `""` and its flags no `title`. The worker probes each track's container
duration itself (ffprobe) and sizes the decode and the disk reservation from
that. `duration` is used only for a track whose duration ffprobe cannot read.

### Progress

```json
{"jobId": "m-lhod-1794710439", "engine": "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v2",
 "state": "encoding", "recordingId": "lhod", "createdAt": 1794710439.83, "updatedAt": 1794710473.52,
 "progress": {"tracksTotal": 1, "tracksDecoded": 1, "tracksEncoded": 0, "encodeQueuePosition": 0},
 "stageTimings": {"identity": 0.39, "decode": 33.29, "encodeQueue": 0.00004},
 "error": null, "resumed": 0}
```

`state` goes `queued` (waiting for the disk budget, or after a restart for its
turn to resume) → `decoding` → `encoding` →
`anchoring` → `aligning` → `finishing` → `done`, or ends in `failed` (with
`error`) or `cancelled`. `progress` grows as the job goes on:
`tracksTotal`, `tracksDecoded`, `tracksEncoded`; `diskReservedBytes`, the
job's current disk reservation; `resumeQueuePosition` (`1…`) while a retained
job waits for its turn after a restart; `encodeQueuePosition` while
encoding (`0` holds the encoder, `1…` waiting behind it); `audioSecondsEncoded` of
`audioSecondsTotal` while encoding, whole seconds of the recording's audio encoded
(tracks finished before a restart included), written at most every 15 s
(`ENCODE_PROGRESS_S`): a track's count moves only when the whole track is done,
and a book of one 23.6 h M4B encodes for hours on lisa's CPU;
`waitingForDisk` (`true` while the job waits for other books to free the disk
budget, `false` once it has its reservation);
`waitingForWindowRequests` (`true` while the encode waits for the window
endpoints' gate, `false` once it got it again) with `gateWaitSeconds`, how long
the current wait has lasted; then `groupsTotal`, `groupsDone` and
`anchors` (`candidates`, `chain`, `chainRateDropped`, `groups`,
`anchorSeconds`); `textMatch` (the check's result, see below) once it ran.
`stageTimings` holds seconds per stage (`identity`, `decode`,
`encodeQueue`, `gateWait`, `encode`, `prepare`, `textMatch`, `anchor`, `align`,
`finish`, `leftover`).
`resumed` counts the worker restarts the job has continued from. `encode` holds the encode statistics (`encodeSeconds`,
`audioSeconds`, `realtime`, `batch`, `oomHalvings`, `gpuUtilization`, and on the CPU `threads`: the
`min`, `max` and `last` torch threads of its batches, see "CPU threads").

### Result

```json
{"jobId": "…", "engine": "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v2", "recordingId": "…",
 "audioFingerprint": "…", "outcome": "mapped", "sentences": 5665, "mapped": 3455,
 "intervals": [{"paragraphId": "5:16", "section": 5, "trackId": "torbox-128690185-1",
                "start": 139.1825, "end": 159.9625, "confidence": 0.65}],
 "unsyncedPassages": [{"section": 1, "title": "Section 2", "firstParagraphId": "1:0",
                       "lastParagraphId": "1:12", "sentenceCount": 13, "excerpt": "…"}],
 "flags": [{"kind": "intro", "trackId": "torbox-128690185-1", "start": 0, "end": 139.1825},
           {"kind": "extra-audio", "trackId": "torbox-128690185-1", "start": 1878.9425, "end": 2107.5025,
            "section": 7, "first": 415, "last": 427, "title": "We Need To Talk About Fifty-Five"},
           {"kind": "extra-audio", "trackId": "torbox-128690185-1", "start": 6111.6625, "end": 6731.4825},
           {"kind": "unmatched-text", "section": 1, "title": "Section 2"}],
 "textMatch": {"score": 0.4351, "threshold": 0.1, "matches": true, "samples": 24, "speechSamples": 24,
               "minimum": 0.0, "maximum": 0.8125, "samplesOver10Percent": 18, "wordHit": 0.9234},
 "tracks": [{"id": "torbox-128690185-1", "decodedSeconds": 31673.922, "containerSeconds": 31673.9,
             "differenceSeconds": 0.022, "durationOk": true, "ranges": 18}],
 "stats": {"chainMapped": 2268, "leftoverMapped": 1187, "groups": 30, "groupStartsSeconds": [0.003, 720.003],
           "anchors": {…}, "leftover": {"rounds": 3, "gaps": 61, "gapSeconds": 28082.3, "probes": 266,
           "located": 101, "pieces": 9, "raw": 1407, "seconds": 14.511}, "windows": 1447,
           "recoveries_text": 412, "recoveries_audio": 414, "gap_filled": 894, "seamTrimmed": 150,
           "orderConflictsDropped": 0, "rawMapped": 2802, "kernel": "numba", "device": "cuda"},
 "stageTimings": {…}, "encode": {…}}
```

`outcome` is one of:

* `mapped`: at least one sentence is mapped;
* `unsynced`: the text matched (or no speech was heard) and no sentence is mapped;
* `text_mismatch` (#403): the text-match check found that the ebook is not the
  recording's text, before any alignment. `intervals` is empty, `mapped` is 0,
  `flags` is empty, `unsyncedPassages` covers the whole book and `textMatch`
  holds the score. The job's `state` is still `done`;
* `language_not_supported`: `language` is not `eng`. The result is
  `{jobId, engine, outcome, intervals: [], tracks: []}`, as before #403.

The server judges coverage. `intervals` has the server's `AlignmentInterval`
shape, sorted by sentence. `start` and `end` are seconds in the track's own
time, on the container timeline. `confidence` follows the server's rule: 0.65
for 0.3 to 6 words per second, else 0.2. Sentences the leftover pass maps can
lie anywhere in the audio, so intervals are not in time order when a recording
reads chapters out of the ebook's order (production's maps of such books are
not either).

`unsyncedPassages` is `UnsyncedPassage[]` (`src/reading-types.ts`), exactly
what `server/alignment-passages.ts` `unsyncedPassages(book, intervals)`
returns for this map: every maximal run of unmapped sentences within a
section, `excerpt` the first 120 UTF-16 units of its first sentence. `flags`
is `AlignmentFlag[]`, the server's `anchoring.flags`, in the key sets
production holds (`tests/worker/test_book_report.py` copies a sample of
each from the production database):

* `intro` / `outro` / `extra-audio` `{kind, trackId, start, end}`: narration
  starts or ends more than 20 s inside a track (`intro` on the first narrated
  track, `outro` on the last, else `extra-audio`), as `planSegments`; a track
  with no mapped sentence is one such flag over the whole track;
* `extra-audio` / `skipped-text` `{kind, trackId, start, end[, section, first,
  last, title]}`: the audio between two mapped sentences next to each other
  on a track is more than 1.3 times and 45 s longer (or less than 0.75 times
  and 45 s shorter) than the unmapped text between them takes at the map's own
  speaking rate (`mismatch` in `server/alignment-anchors.ts`); `first` and
  `last` are the unmapped sentences between, by index in the request. Where
  the map jumps (the text between the two runs backwards, or some of it is
  mapped elsewhere in the audio) there is no text between them, so only
  `extra-audio` without `first`/`last` can apply;
* `unmatched-text` `{kind, section, title}`: a section of at least 40 words
  with no mapped sentence, as `server/alignment.ts` adds after an anchored run.

`title` is the request's section title, on every flag with a `section`.
`textMatch` is the check's result (below). `stats.chainMapped` counts the
sentences the chain mapped and `leftoverMapped` those the leftover pass added;
`stats.leftover` describes the pass. `tracks` is the per-track duration check:
the decoded length against the container duration (ffprobe), `durationOk`
within 0.25 s.

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
  The ranges of a track are joined in place: appended to the first one and
  deleted one at a time, so a join never holds a second copy of the track.
* **Bounded writes.** Every ffmpeg gets a byte cap (`-fs`): its range's
  length plus 2 s, or for the last range of a track the rest of the
  container's duration plus 10 % and 1 s. A range that reaches its cap fails the
  job (`Track N decodes to more audio than its container's … allow`), so a
  file that holds more than its container says cannot write past its
  reservation. ffmpeg stops at most 225 KB past a cap (measured on WSL, ffmpeg
  6.1, WAV, AAC and MP3, caps 0.1 to 200 MB); 1 MiB is allowed per range.
* **One continuous encode.** The windows of all tracks (each track on its own
  grid: 20 s cores, 5 s context) form one stream. Consecutive windows of equal
  length are batched, `ALIGNMENT_BOOK_ENCODE_BATCH` (default 8 on a GPU and 1
  on the CPU, see "Shared GPU"), with no padding.
  Each track's emissions (float16, 29 labels) go to their own file. A track's
  PCM is deleted once its emissions are written.
* **One encode per GPU.** Jobs enter a first-come queue per device before
  encoding. Decoding and aligning of other books run beside it. The window
  endpoints do not use the queue.
* **Shared GPU.** Each encode batch also holds one slot of the gate the window
  endpoints use (`deadline.Gate`, `ALIGNMENT_WORKER_SLOTS`), only for that
  batch, with the batch's results back on the CPU before the slot is given
  back. `/health`'s `busy`, `activeRequests`, `busySeconds` and `stuck` do not
  count book batches (the server reads `/health` first and skips a worker that
  says it is busy); `bookJobs.slotsHeld` does. Window requests come first: a
  batch starts only when no window request runs or waits, none ended in the
  last 2 s (`WINDOW_GRACE_S`; a window job's next request follows within it)
  and no window request refused with `409` is still due to retry (the server
  retries after 3 s; the batch waits for it at most 5 s, `WINDOW_RETRY_S`). A
  window request is refused only when window requests hold every slot, as
  before. One that arrives while a batch holds the slot it needs waits for
  that batch, so for at most one batch, and no batch starts while it waits.
  The longest batch, measured on WSL (2026-11-15, 30 s windows, results back on
  the CPU): 8 windows on the RTX 3070 Ti in float16 take 0.13 s; on the CPU in
  float32 one window takes 0.93 s with 8 threads, 1.3 s with 4 and 4.8 s with
  1, and 8 windows 12.9 s with 4 threads. So a CPU batch is one window. lisa
  (Xeon E5-2470 v2, 20 threads) was not measured; its per-thread speed is
  lower, so a batch there may take a few seconds, far inside a window
  request's own limit (120 s plus 0.15 s per audio second) and the server's
  wait. A batch that holds the slot for more than 60 s
  (`WINDOW_WAIT_MAX_S`) is taken to be hung and the waiting request gets
  `409`, as when every slot is taken. While window requests keep arriving
  within 2 s of each other the encode waits, with no timeout; the job says so
  in its progress (`waitingForWindowRequests`, `gateWaitSeconds`) and later
  books keep their `encodeQueuePosition`. A cancel during that wait stops the
  job. That status is written to `state.json` only while the book holds no
  slot: the end of a wait is reported just before the slot is taken (and when
  a window request came in meanwhile the book waits again), so a slow or stuck
  disk write never keeps a window request waiting or refused.
* **Book bookkeeping stays off the window path.** No lock that `/health`, a
  window request or the gate waits on is held across file I/O, hashing, a
  process wait or a sleep (the lock table is in `worker/book_session.py`).
  `/health` and a job's status read a copy of the job list that is replaced,
  not changed, so a start or the resume stalled on a slow disk does not delay
  them.
* **The aligner** is the v2 anchor chain of `PROTO-D-E-BOOKS.md`, unchanged in
  its parameters (δ 1.5, skip 8, 60 s windows, 20 s margin, text × 1.3) and its
  four chain constants (locate every 240 s, groups ≥ 600 s, rate floor 0.25).
  It locates the text over the whole book, keeps the longest chain rising in
  audio and text, and aligns the groups in a process pool
  (`ALIGNMENT_BOOK_ALIGN_WORKERS`, default CPUs − 2, at most 8). A recovery jump
  stays inside its group. The worker's `accepted_intervals` then validates the
  merged map.
* **Seam fix.** v2 lost 6 to 15 sentences per book at group cuts. The next
  group's text starts 10 sentences before its located sentence, which can be
  heard up to 120 s after the cut, while the earlier group stopped 30 s past
  the cut. A group's audio now runs 150 s past the next group's start (the
  120 s locate window, the 20 s margin and 10 s slack). Before merging, the last
  20 s of a non-final group and the first 20 s of a non-first group are dropped,
  the same margin a window keeps uncommitted. A sentence cut by a group end
  therefore comes from the neighbouring group, where it is whole.
* **Text-match check** (#403, `book_match.py`). After encoding and before
  anything is aligned, up to 24 evenly spaced 60 s stretches of the job's own
  emissions are decoded greedily: 24 on a recording of 28 minutes or more, two
  minutes away from each end; a shorter recording keeps a tenth of its length
  at each end and gets as many stretches as fit side by side (3 on 4 minutes),
  so a spoken introduction is never the whole check; under 75 s, the whole
  recording is one stretch. The score is the median share of their word
  4-grams found anywhere in the ebook, whose 4-grams run across sentence
  boundaries as the heard ones do, counting only stretches with at least 20
  heard words. Below `book_match.MATCH_THRESHOLD` (0.10) the job ends with
  `text_mismatch`. Measured on the 2026-11-14 set: matching pairings 0.435
  (*Antimemetics*, a rewritten edition that matches in part) and 0.655 to
  0.902 (the other 12); mismatches 0.000 (*Snow Crash*'s non-English ebook,
  *Left Hand*'s text on *Hydrogen Sonata*'s audio), 0.016 (*Matter*: the audio
  is another book) and 0.031 (DCC 2's text on DCC 1's audio). With no stretch
  of speech at all (also a recording under 75 s with fewer than 20 heard
  words) the check does not decide; the alignment then maps nothing
  (`unsynced`). It takes well under a second; it keeps no text.
* **Leftover pass** (#403, `book_align.leftover_pass`). After the chain's
  groups are merged: every unmapped audio stretch of at least 120 s is located
  every 120 s against unmapped text runs of at least 20 sentences only. Probes
  in the same run whose sentences do not run backwards form a piece; a piece is
  aligned with the same long-form pass, its text from 60 sentences before the
  first located sentence to its run's end, its audio from one probe before it to
  one probe past the next piece. A sentence is kept only when the chain did not
  map it, it lies inside the stretch, and no mapped sentence's audio overlaps it.
  Up to three rounds. The chain's merged map is validated as before and each
  piece on its own, so the pass can add sentences but never move or drop one
  the chain mapped. *There Is No Antimemetics Division*, whose recording reads
  chapters in another order than its ebook: the chain maps 2,268 sentences
  (40 %); with the pass 3,455 (61 %), production's sections 16, 19 and 24
  included, and every chain interval is kept exactly; 14.5 s with numba. On
  the books read in the ebook's order it adds nothing (0.003 to 1.4 s). Like
  the anchor chain and the validation, it runs in the job's thread, not in the
  group processes.
* **CPU threads** (#913, `worker/cpu_share.py`). On a CPU host the encode
  sets its torch threads before each batch to the cores no other running work
  of the worker claims: every core of the process's affinity mask (lisa: 20)
  while the book encodes alone. Another book's decode claims its ffmpeg
  processes and its align stage the job's thread plus its process pool for as
  long as they run, so the next batch leaves those cores to it and the batch
  after that one takes them back. Window requests claim nothing: a batch starts
  only when none runs or waits, so one that arrives during a batch and finds a
  free slot shares the cores with that batch only until it ends (one 30 s
  window, about 4.5 s on lisa). torch's thread count belongs to the calling
  thread, so each window request sets its own share (cores / `slots`, or with
  one slot torch's default) before its forward pass and keeps it whatever the
  encode uses. Before #913 the worker set cores / `slots` (lisa: 6) for
  everything, also while one book encoded alone. Measurements: "CPU encode
  speed on lisa" below.
* **Viterbi kernel.** numba when installed (the pool hosts' production
  environments do not have it), otherwise an equivalent numpy kernel.
  `tests/worker/test_book_align.py` checks that the two give identical paths.
  `stats.kernel` says which one ran.

### Session, disk budget and resume

Each job has one per-book session (#391), keyed by the job. The session owns the
decoded audio, the tracks' digests, the emissions handle and the process pool.
It ends exactly once:

* when the result is fetched (the whole folder goes);
* on cancel (the whole folder goes);
* after `ALIGNMENT_BOOK_IDLE_SECONDS` (default 900) without a request for the job
  from the server, which also stops a running job and deletes its folder;
* on failure, when only a small error record (`state.json`: the job's id,
  engine, state, error cut to 2,000 characters and times) is kept and counted
  in the budget until the idle sweep removes it;
* on worker stop, when the folder is kept. A job thread still running after
  `STOP_WAIT_S` keeps its reservation and is listed as stuck.

Ending a session stops its group-alignment processes first: SIGTERM, then
SIGKILL after 5 s (`book_session.TERMINATE_GRACE_S`), then a wait of at most
5 s more (`KILL_WAIT_S`). Cancel, fetch and idle end also wait up to 30 s
(`book_job.STOP_WAIT_S`) for the job's thread. Only when all of them are gone
are the folder deleted and the reservation released, together. A process that
is still there (stuck in the kernel, for example on a read from a failing
disk), or a thread that has not stopped, keeps the session: the folder and the
reservation stay, `/health` lists the job under `bookJobs.stuck`, a new start
of the same `jobId` is `409`, and the sweep (every 30 s) releases it once
everything has exited. A visible leak is preferred to disk reused under a live
process.

A job ends once at a time: when cancel, fetch, the idle sweep or the job's own
failure end it together, the later caller waits for the first end and gets its
outcome; it never deletes the folder or releases the reservation itself. The
reservation shrinks only by the bytes really removed: a file that fails to
delete stays reserved, the job is listed under `bookJobs.stuck`, and the sweep
tries the delete again. A failed job's error record is reserved before the
rest of its bytes are released. A `start` that fails after writing deletes
what it wrote and keeps reserved what it could not delete.

Locks are taken in the order `Job.end_lock` → `BookJobs` → session registry →
session → disk budget, and `Job.save_lock` before `Job.lock`. No lock is held
while waiting for the encode queue, a process or book I/O, except a job's
`end_lock`, which its end holds throughout so that a second end waits for it.

An encode batch's report that it waits for or got the gate (a `state.json`
write) never holds the gate: a failed report is logged, and the batch's slot is
freed on every exit once taken.

One disk budget per worker, `ALIGNMENT_BOOK_DISK_BYTES` (default 64 GiB), covers
every byte in the job folders. A job's reservation is what its folder holds plus
the most the next stage adds at its peak, set again before each stage that
writes, from the probed durations and the files on disk:

* before decoding: every range at its cap plus one range for the join (PCM is
  32,000 B/s), the missing tracks' emissions (2,900 B/s) and the book's
  concatenated copy of all emissions;
* after decoding: the emissions still to be written and the book copy, exactly;
* before the book copy is written: its size;
* before the result is written: its exact size and its temporary copy (the
  JSON is counted as a stream first, then written); a result that cannot fit
  fails the job with `error` "The book's result is … bytes of JSON and was not
  written: …", and nothing is written. Its passages and flags repeat their
  section's title (as the server stores them), so no per-sentence estimate
  bounds it. The result is written once;
* always (until the result): 16 MiB plus 1 KiB per sentence for the state,
  plan and group files.

`start` reserves the request and state files it writes (the request's exact
size plus 64 KiB): a request that does not fit next to the other jobs is
refused with `507` before anything is written. Lowering a reservation never
waits. Raising one is first come, first served: only the oldest waiting job
may grow, and it fails with a clear error ("can never fit") when it cannot fit
even after every job that is not waiting has released its bytes, that is when
the rest is held by jobs that release only after it (later waiters, retained
jobs still to resume, folders the worker does not recognise). A book larger
than the whole budget fails at once. A failed job's files go except its
record. So two books can never wait for each other's disk.

When the worker starts, it serves `/health` and the window endpoints at once
and picks up the retained job folders in a background thread; until that has
finished (or failed, which is logged), book requests are answered `503`, so
none of them meets a half-loaded job. The files of every retained job folder (and of any
folder it does not recognise) are claimed in the budget before any job is
resumed, so a restart cannot admit more than the disk holds; decoded PCM and
partial files of unfinished jobs are deleted first, as they are never reused.
Unfinished jobs then resume one at a time, oldest first (`createdAt`); the
next starts when the previous one's run has ended (done, failed or cancelled).
While a job waits for its turn its files count as held for the one resuming.

Everything is kept under `MEDIA_ROOT/alignment/book-jobs/<jobId>/`:
`request.json`, `state.json`, `tracks/` (PCM), `emissions/<n>.f16` + `<n>.json`
(per track, with engine and source sha256), `emissions/book.f16`,
`groups/plan.json` and `groups/<n>.json` (one per finished group),
`result.json`. Groups are the unit of progress and resume. When the worker
starts, every unfinished job continues, in turn. Tracks whose emissions match their
source digest are not decoded or encoded again; the stored plan and finished
groups are reused. A track whose bytes changed is decoded and encoded again,
and the book copy of the emissions, the plan and the finished groups are
computed again: all three carry `emissionsKey`, a hash of every track's
emission identity (source sha256 and engine) and frame count, and are reused
only when it matches. A job folder written by another engine generation starts
over.

### The server's whole-book runner (#404)

`ALIGNMENT_BOOK_JOBS=1` on the server (read only by `bookJobsEnabled()` in
`server/alignment-engine.ts`) makes the whole-book engine the current one: new
jobs and rebuilds are planned under it, so every map of the window engine is
rebuilt, and every full alignment (anchored and chapter-paired alike; the
pairings are not used) runs in `server/alignment-book-job.ts` as one job on the
worker under one worker lease. Unset, nothing of the window runner changes.

* **Lease.** The lease takes only a host whose `/health` reports `bookJobs`
  with the whole-book engine and `ready` (a host without them is skipped with
  "worker runs no whole-book jobs"), and tries the host the job was started on
  first (`firstHost`), so a restarted server goes back to it.
* **CPU hosts are the fallback only.** A book takes hours on a host whose
  configured `device` is `cpu` (lisa) and minutes on a GPU host (WSL). The
  lease tries the other hosts first, in rank order, and while one of them is
  healthy and only busy (its slots taken, or `/health` busy) a whole-book job
  waits in the queue for it rather than taking the CPU host. The CPU host takes
  the job only when no other host can be used for it: unreachable, unhealthy or
  stuck, without whole-book jobs, or already tried by this job (it failed there).
  The host the job was started on (`firstHost`) is never held back. Window-runner
  jobs and ebook-set probes keep plain rank order. The rule reads the host
  configuration (`device`, `rank`), never a host id (ADR 0013).
* **Reading sync page.** Each poll also stores the worker's counts for its stage
  in `bookJob.counts` (`tracksTotal`, `tracksDecoded`, `tracksEncoded`,
  `groupsTotal`, `groupsDone`, `encodeQueuePosition`, `resumeQueuePosition`,
  `audioSecondsEncoded`, `audioSecondsTotal`, `waitingForWindowRequests`,
  `waitingForDisk`; a count that is not a non-negative integer is left
  out). The Reading sync page (`#book/<workId>/sync`, #540) shows a running
  whole-book job as its steps with the count of the running one (`runPoint` in
  `src/pages/reading-sync-model.ts`), for example "24 of 43 files"
  (or "20%" of the audio while encoding, where the worker reports it),
  "1 of 2 files", "1 book ahead", "34 of 83 parts", and its pause button reads
  "Pause": the worker's job is cancelled at once.
* **Start, poll, fetch, publish.** The start request carries the ebook's
  sentences in reading order and the staged tracks in play order, with the
  durations the database holds. The worker's job id is the job's id and
  generation (`bookWorkerJobId`). Progress is read every 5 s
  (`BOOK_POLL_MS`) into the job's `progress`, `stageTimings` and `bookJob`
  (`{id, hostId, state, resumed, startedAt}`). The result is turned into the
  stored map by `applyBookResult` and published with `publish`, so the #379
  rule keeps a better kept map. The map records the engine the result names,
  which must be the whole-book engine.
* **A job the worker may be running.** From the moment the start is sent,
  the worker's job counts as possibly existing until a 404 for its id says
  otherwise: a lost start reply changes nothing. The run stores `bookJob` with
  state `starting` before it sends the start, so a server that stops before the
  reply polls that id after its restart. Every end of the run on a host except a
  server stop and a published result (pause, cancel, a new plan, a deleted row,
  a failed host before the fallback, a refused start, every terminal failure)
  first sends the cancel (`DELETE`) for that id on that host and waits for the
  answer, within the cancel's 90 s bound; a 404 is success. Only then does the
  run end and the lease go back.
* **A cancel that fails or times out.** The lease is still released, so the
  stored job becomes paused, cancelled or moves on as asked. The failure is
  logged, written to the job's `poolErrors` for that host (while the job is
  active or paused; a cancelled job cannot be written), and the name of the
  folder the job staged on that host is retired (`retireStagingName`, the #421
  table). The worker's job may still be reading that folder, so the job's next
  run stages under `<id>.r<n>`, on every host. A probe never touches that
  folder: it stages and removes only its own. The sweep removes a retired
  folder once no lease or run of its job is live; that can only cut short the
  worker job the server already gave up, whose result is never fetched.
* **Pause and resume.** Resume is a new generation and therefore a new worker
  job that starts from nothing: the worker's decoded audio, emissions and
  finished groups are lost. That is the cost of the stored job never saying
  "paused" while the worker still works on it, and of a paused job holding no
  host slot. A pause keeps the host slot until the worker has answered the
  cancel (at most 90 s).
* **Server restart.** A stopping server does not cancel the worker's job. The
  next process's run of the same generation leases the stored host first
  (`firstHost`) without staging (`unstagedFirstHost`): it holds the slot and the
  recording and uploads nothing while the worker's job exists, and polls the
  stored id. Only when the worker answers 404 (it lost or ended the job, for
  example after 15 idle minutes) are the tracks staged again
  (`WorkerLease.stageTracks`) and the job started again there. When the stored
  host cannot be leased, the job's worker job there is cancelled before the
  other host starts it. A result the server fetched but did not publish before
  it stopped is gone, and the job runs again.
* **Worker restart and failed answers.** A worker that answers 503 (it still
  picks up its retained jobs), does not answer, or answers 2xx with a body that
  cannot be read or is not a progress answer, is waited for, polling every 5 s,
  up to `BOOK_WORKER_RESTART_WAIT_MS` (5 minutes). A status of `done` whose
  result fetch then fails (no answer, 409, 5xx, a cut body) does not restart that
  clock. After the bound, or when the job fails on the worker, the result cannot
  be read, names another engine, or the worker lost the job more than three
  times, the host has failed for this job: the run cancels the job there and
  moves to the next host once, as the window runner does; with no host left the
  job fails with the reason. A start answered 413 or 422 fails the job at once;
  400, 401 and 507 count as a failed host. A 409 at start is answered by one
  cancel and a new start (the same id with another request), then waited for.
* **Not done here.** The text-match outcome, unsynced passages and extra-audio
  flags arrive with #403; `applyBookResult` is where they go. A run that ends by
  an exception (another process took the job over, a closed database) sends no
  cancel: after a takeover the other process polls the same worker job.

Tests: `tests/alignment-book-job.test.ts` against the fake whole-book worker
`tests/fake-book-worker.ts` (real HTTP on 127.0.0.2, fake SSH staging); the
page's steps and labels in `tests/reading-sync-model.test.ts`.

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

## CPU encode speed on lisa, 2026-11-26 (#913)

lisa: Xeon E5-2470 v2 (Ivy Bridge, 10 cores, 20 threads, AVX but no AVX2 or
FMA), torch `2.8.0+cpu` (OpenMP, MKL, oneDNN 3.7.1), float32. Measured with
the worker's own code from `~/sonder-replication/issue-913/` while lisa ran no
alignment job (its other services, Prowlarr among them, ran as usual), nice 10
like the service, on a copy of *The Butcher's Masquerade* (one 23.6 h M4B,
84,845 s). `worker/measure_encode.py` decodes a stretch as a book job does and
encodes it with `book_encode.encode_tracks` (one 30 s window per batch):

    measure_encode.py --alignment ~/sonder-ctc-worker/media/alignment \
        --audio book.m4b --start 36000 --seconds 300 --threads 6,10,14,20 --out runs/sweep

| torch threads | audio s per wall s (300 s from 10:00:00) | 23.6 h book's encode |
| ---: | ---: | ---: |
| 6 (before: 20 cores / 3 slots) | 3.72 | 6.3 h |
| 10 | 3.80 (repeats 3.7 to 4.8) | 6.2 h |
| 14 | 3.82 | 6.2 h |
| 20 (now: every core, alone) | 4.22 (repeats 4.4 to 4.5) | 5.2 to 5.6 h |

The 6-thread figure matches the real job of #912 (about 6.5 h to encode).
Emissions at 10, 14 and 20 threads against 6: the same argmax on all 14,999
frames, at most 0.0156 apart in log-probability (one float16 step) and 0.0005
in probability. Map comparison: the book's first hour (a WAV of 3,600 s
with the book's whole sentence list) run twice through the worker's own job
stages, `WorkerStages` with the pinned model, the encode held to 6 threads and
then to 20: both map the same 921 sentences with identical intervals (no
difference at all). That run took 1,308 s to encode at 6 threads (2.75x,
slowed by a leftover measurement process beside it) and 890 s at 20 (4.05x).

**The whole job.** The decode of this book takes 40 s on lisa (the job of
2026-11-26, 48 ranges), the encode as above, and the text match, anchors,
align, leftover pass and finish took 19 s together for the book's first hour
(the job of the map comparison: align 16.1 s, prepare 1.3 s, the rest under a
second each), so about 7 minutes for the whole book. So the job takes about
6.5 h before (6.3 h of encode) and 5.3 to 5.7 h now. The real job's time comes from the next
whole-book job on lisa after the worker update (`stageTimings`, and
`encode.threads` says what the encode used).

**Where the time goes.** One 30 s window at 20 threads takes about 4.4 s:
the feature extractor's convolutions 1.4 s and the transformer 3.0 s. The
convolutions do not get faster past 6 threads (1.44 s at 6 and at 20), the
transformer stops at the 10 physical cores (4.45 s at 6, 2.9 s at 10, 3.0 s at
20). In the transformer, attention (`_scaled_dot_product_flash_attention_for_cpu`)
takes as long as all linear layers together. Checked and not taken:

| Option | Measured on lisa | Result | Why not taken |
| --- | --- | --- | --- |
| Math attention instead of flash | transformer 3.7 s instead of 3.0 s | same | slower |
| Convolutions without oneDNN | feature extractor 1.08 s instead of 1.43 s (10 threads), about 8 % of a window | same (5.5e-7) | a process-wide switch that also changes window requests, and every convolution then logs an NNPACK warning |
| Batch of 4 windows | 3.95 s instead of 4.45 s per window (11 %) | same | a window request may wait for a whole batch: 4 times as long |
| Two to four encode streams of 5 to 10 threads (in one process) | 5.0 to 5.4x against 4.4x in one round, 2.4x in the other | same as that thread count | inside lisa's spread from run to run; it needs ordered writes and several gate slots |
| OpenVINO float32 (prototype D+E) | 0.52x | about the same | far slower without AVX2 |
| ONNX Runtime float32 (prototype D+E, 16 threads, batch 4) | 5.74x against 4.85x (+18 %) | map agreement 100 % on 1 h | a second inference runtime and a 378 MB export; its threads are fixed per session, so the thread rule would need a session per count |

**Under 2 hours** needs about 12x realtime, about 2.7 times the 4.4x of every
core. That changes the result, so a new engine (ADR 0006), and it is left to
the owner. Measured in prototype D+E on lisa (16 threads, batch 4, the
first hour of a book, against production's map):

| Option | Speed on lisa | 23.6 h book's encode | Map against production |
| --- | ---: | ---: | --- |
| wav2vec2 Base (the engine) | 4.85x | 4.9 h | 100 % of its sentences, median 7.5 ms |
| Dynamic int8 of the same model | 5.0x | 4.7 h | 99.8 %, but 5 % of frames change their argmax |
| DistilWav2Vec2 (52 M parameters) | 7.36x | 3.2 h | 98.5 %, median 7.5 ms |
| SEW-D tiny (24 M parameters) | 19.1x | 1.2 h | 98.1 %, median 20 ms, p90 32.5 ms |
| Shorter context, 2.5 s instead of 5 s (25 s windows), estimated from the profile | about 1.25x faster | about 4.4 h | not measured; the edge frames of each core change |

Only SEW-D tiny reaches 2 h on lisa. WSL's GPU encodes the same book in
minutes, which is why a whole-book job takes lisa only when WSL cannot be used
("CPU hosts are the fallback only").

## Probing gate (#278)

The one-off CTC and Whisper probing comparison passed for all eight titles; the results are recorded in [PR #375](https://github.com/jahnzh/sonder/pull/375). The comparison scripts and Whisper prober have been retired.

## Implementation evidence

| Proposal | Evidence |
| --- | --- |
| Route CTC to WSL first and lisa as the only fallback; never send it to production. | `tests/alignment-ctc.test.ts`: unreachable, busy or incompatible WSL; legacy assignment; disabled pool; and cross-host retry tests. `tests/alignment-pool.test.ts`: production URL rejection, SSH diagnostics and staging tests. |
| Hand out worker leases: first healthy host by rank, fallback when down or full, re-staging after a worker or server restart, release on every exit, staged audio removed on a finished release only (#394). | `tests/alignment-worker-lease.test.ts` (in-process fake hosts, `tests/fake-pool-host.ts`); host configuration in `tests/alignment-pool-hosts.test.ts`. |
| Remove staged job audio under the recording's lease, with a dry run per host; a retired folder name is never staged into again, so a late removal cannot reach a later run (#421). | `tests/alignment-pool-sweep.test.ts` (fake hosts), `tests/alignment-pool-sweep-routes.test.ts` (admin only). |
| Worker hosts on the Activity page (#357 PR 3): online, current job and code version per host; restart refused while the host runs work or cannot be read unless forced, with the result on the row; per-host disable honoured by every lease and surviving a restart. | `tests/activity-worker-hosts.test.ts` (fake workers, `tests/fake-book-worker.ts`; the restart command is recorded, never run); `tests/worker/test_revision.py`. |
| Use reported device and busy state for capability and capacity. | `tests/alignment-ctc.test.ts`: incompatible or busy WSL and both workers busy. Real `/health` responses identified WSL as CUDA float16 and lisa as CPU float32 before the gates. |
| Retry a failure once on the other host, retain a retryable failure, and keep CPU and GPU in the same engine generation with device and precision for diagnostics. | `tests/alignment-ctc.test.ts`: cross-host retry and manual Resume, anchored-window failover, and the CPU and GPU metadata assertions. |
| Install the lisa environment with the pinned CPU wheels and the anchored planner dependency; document the commands. | The commands above completed on lisa; its environment imported Torch and TorchAudio `2.8.0+cpu`, FastAPI `0.121.3`, Uvicorn `0.38.0`. |
| Run both real-model gates and report their outcomes. | The two tables above show identical passing results. |
| Reproducible install script (`scripts/install-ctc-workers.sh`), systemd user service unit template (`deploy/ctc-worker.service.tmpl`), Caddy reverse-proxy snippet template (`deploy/ctc-worker.caddy.tmpl`), and documentation runbook. | `tests/install-ctc-workers.test.mjs` verifying installer CLI, help flag, syntax, service template, and Caddy configuration. |

The pool remains off by default. No schema migration is needed. The worker
ran `npx tsc --noEmit`, the focused alignment tests, `npm test`, and the Python
worker tests; the coordinator runs `npm run check -- --ref <commit>` on the
committed revision.
