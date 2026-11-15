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
4. Writes `worker.env` (`ALIGNMENT_WORKER_TOKEN`, `MEDIA_ROOT`, `ALIGNMENT_CTC_DEVICE`, and `ALIGNMENT_WORKER_SLOTS` with `--slots`), mode 0600. Without `--token-file <path>` or `ALIGNMENT_WORKER_TOKEN` in the environment it generates a token; the installer never prints a token, it names the file: copy `ALIGNMENT_WORKER_TOKEN` from `worker.env` on the host to the production `.env`. (`--token` was removed: a command-line value shows in process listings.)
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
   wait until no request runs (`activeRequests` 0, `busy` and `stuck` false,
   and in `bookJobs`: `jobs` 0, `slotsHeld` 0, `resuming` false):

   ```sh
   curl -s http://192.168.1.119:3012/health | jq '{activeRequests, busy, stuck, revision, bookJobs}'
   ```

   This step is required: the worker has no drain mode, so nothing on the host
   stops the server from sending a request after the installer's last check
   (see the limitations below).

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
   - takes `~/sonder-ctc-worker/.install.lock` for the whole run (an update,
     `--verify`, `--rollback` and `--prune` refuse with exit 3 while another
     holds it);
   - refuses (exit 3) while `/health` shows a running request, a busy or stuck
     worker, whole-book work (`bookJobs.jobs` above 0, `bookJobs.slotsHeld`
     above 0, or `bookJobs.resuming` true; `jobs` counts retained book jobs,
     finished ones not yet collected included), or cannot be read or
     understood: `busy`, `stuck` and `bookJobs.resuming` must be JSON booleans
     and `activeRequests`, `jobs` and `slotsHeld` JSON integers, anything else
     is unknown. A worker from before #402 has no `bookJobs` and runs no book
     work. `--force` is the only way past, and interrupts whatever runs;
   - copies the code to a new `releases/<revision>--<env>/` and builds or
     reuses `envs/<env>/`, downloads the model into the `MEDIA_ROOT` the
     worker uses (read as systemd reads `worker.env`: quotes, CRLF), without
     touching the code, packages or settings of the running worker;
   - writes `worker.env` keeping every line it does not set byte for byte (a
     key it sets or changes is removed where it was and written as a new line
     at the top of the file, so no kept line changes, not even an unterminated
     last one); saves the current `worker.env`, unit and release in
     `rollback/` (with `--skip-service` too), and for a file that does not
     exist the explicit record `no-worker-env` or `no-unit`;
   - switches `worker.env`, `current` and the unit, runs `daemon-reload` and
     `enable`, reads the unit's `ExecMainStartTimestampMonotonic`, checks
     `/health` a last time and restarts the service once. If that last check
     finds a request, it puts the saved `worker.env`, unit and `current` back,
     reloads, removes `rollback/` and exits 3 without restarting: the old
     worker never stopped running from its own paths;
   - verifies, for up to `--verify-timeout` seconds (default 300): the unit is
     `active` and its main process started after the time read before the
     restart (so a restart that did not happen fails even when the old process
     answers with the same values), then the `/health` fields the server
     checks (`ready`, an absolute `mediaRoot`, boolean `busy`/`stuck`,
     `ctc.engine` of this revision, `ctc.ready`, `ctc.device` and
     `ctc.precision`), `mediaRoot` equal to the configured root and
     `revision` equal to the installed revision, then sends one authenticated
     request: an `/anchor-batch` naming a new random file under
     `MEDIA_ROOT/alignment/` that cannot exist. The worker checks the token
     first, so a matching token gives HTTP 400 ("The audio must be on the
     configured media drive.") or 409 (every slot busy) and a wrong one 401;
     only 400 or 409 proves the token.

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
   once and verifies the previous worker like an update does: the unit
   restarted, the `/health` fields the server checks for the previous code's
   engine and the saved device, media root and revision (when it had one;
   `unknown` for a worker from before #411), and one authenticated request
   with the saved token. With the record `no-unit` (there was no worker
   before) it stops and disables the service and removes the unit instead. It
   refuses, before changing anything, when the saved state has neither a file
   nor its record. It refuses while the new worker runs requests, like the
   update; `--force` interrupts them. The status is `rolling-back` until the
   restored worker verified, then `rolled-back`; a rollback that failed or was
   killed is finished by running `--rollback` again, which does the same
   steps. `--rollback --skip-service` restores the files only and stays
   `rolling-back`. Until you roll back or verify, a new update refuses: when
   the worker only needed longer to load, run `--verify`, which checks again
   and restarts nothing. `journalctl --user -u sonder-ctc-worker.service` on
   the host shows why a worker did not start.

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
   after a verified update, holds the install lock for its whole run and
   decides what to remove after it holds it, reads the unit that is installed
   now and refuses (exit 3, nothing removed) when that unit names any path on
   its list (itself or below it, `%h` and symlinks resolved), and restarts
   nothing. `--prune --skip-service` is refused: prune must read the unit.
   After it, `--rollback` has nothing to restore.

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
├── rollback/                       # worker.env or no-worker-env, unit or no-unit, current, previous-revision, revision, status
├── .install.lock                   # held by the run in progress
├── worker/, env/                   # the layout from before #411, until --prune
└── media/                          # the default MEDIA_ROOT of a new host
```

The unit names the release and environment by their real paths, so switching
`current` or adding a release never changes what a running worker imports.
Those paths go into the unit unquoted, so `--dir` must be an absolute path of
letters, digits and `. _ - + , @ : = /`; any other character (whitespace,
quotes, `\`, `%`, `$`, …) would need quoting in the unit and is refused (exit
2) before anything changes, also with `--host` before anything is shipped.

Accepted limitations:

- The worker has no drain mode, so the installer cannot stop the server from
  sending work: its last `/health` check runs after every file and the unit
  are in place, immediately before the one restart, but a window remains in
  which a request can arrive and is then interrupted. Pause the alignment
  processor first (step 1). A job the server is still staging when the worker
  restarts fails like any request to a restarting worker and runs again on the
  other host or waits.
- Verification proves that this unit restarted, but not that the process
  answering at `--worker-url` is that unit's: a different worker reachable at
  the same URL with the same revision, device, media root and token cannot be
  told apart from here. Use the default URL (loopback on the host), which only
  the unit's port serves.
- With `--skip-service` nothing is restarted or verified: restart the worker
  yourself, then run `--verify` (it checks that the unit is active, not that
  it restarted).

The tests run the whole procedure against a fake host (temporary directories,
host steps replaced, a fake worker on a free local port):
`tests/install-ctc-workers-update.test.mjs` and
`tests/ctc-worker-install-helper.test.mjs`. In that test mode the installer
has no default directory or worker URL, a host step a test did not replace
refuses instead of reaching a host, and the HTTP steps refuse any URL that is
not loopback (`127.0.0.1`, `localhost`, `[::1]`).

## Whole-book jobs (#402)

ADR 0016's whole-book request, on the worker only: the server does not call it
yet. The window endpoints (`/align`, `/anchor`, `/anchor-batch`) and their
engine `ctc-wav2vec2-base-960h-torchaudio-2.8-v2` are unchanged. A whole-book
job is a new engine generation, `ctc-wav2vec2-base-960h-torchaudio-2.8-book-v1`
(`book_job.BOOK_ENGINE`), with the same model. `/health`'s existing fields
(`busy`, `busySeconds`, `activeRequests`, `slots`, `stuck`) describe window
requests only, exactly as before; book work is reported only under
`bookJobs: {engine, ready, jobs, resuming, slotsHeld, batchSeconds, stuck,
diskReservedBytes, diskBudgetBytes}`. `resuming` is `true` while the worker
still picks up its retained job folders after a start (book requests get
`503` until then). `slotsHeld` is the number of the
worker's slots that encode batches hold at that moment and `batchSeconds` the
age of the oldest (see "Shared GPU"); `stuck` lists the jobs whose session is
kept because a process is still there or files of its folder could not be
deleted (`jobId`, `reason`, `since`, `reservedBytes`, see "Session, disk
budget and resume").

Code: `worker/book_job.py` (lifecycle, stages, resume), `book_session.py`
(per-book session, #391), `book_audio.py` (decode), `book_encode.py`
(encode and encode queue), `book_align.py` (aligner). `gate_book.py` and
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
              "duration": 36458.949}]   // in play order; duration = listed seconds (> 0)
}
```

The job's identity is a hash of `recordingId`, `audioFingerprint`,
`language`, `sentences` and `tracks`. The worker probes each track's container
duration itself (ffprobe) and sizes the decode and the disk reservation from
that. `duration` is used only for a track whose duration ffprobe cannot read.

### Progress

```json
{"jobId": "m-lhod-1794710439", "engine": "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v1",
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
encoding (`0` holds the encoder, `1…` waiting behind it);
`waitingForWindowRequests` (`true` while the encode waits for the window
endpoints' gate, `false` once it got it again) with `gateWaitSeconds`, how long
the current wait has lasted; then `groupsTotal`, `groupsDone` and
`anchors` (`candidates`, `chain`, `chainRateDropped`, `groups`,
`anchorSeconds`). `stageTimings` holds seconds per stage (`identity`, `decode`,
`encodeQueue`, `gateWait`, `encode`, `prepare`, `anchor`, `align`, `finish`).
`resumed` counts the worker restarts the job has continued from. `encode` holds the encode statistics (`encodeSeconds`,
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
* always: 16 MiB plus 1 KiB per sentence for state, plan, group and result files.

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
