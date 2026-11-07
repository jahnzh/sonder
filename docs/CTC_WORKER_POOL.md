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

## Lisa CPU environment

On 2026-11-07 lisa had Python 3.14 as its system Python and an existing
Python 3.11.13 at the path below. These are the commands used to install the
persistent environment; run the `scp` command from the repository checkout:

```sh
ssh lisa 'mkdir -p ~/sonder-replication/issue-275-setup'
scp worker/requirements-ctc.txt lisa:~/sonder-replication/issue-275-setup/requirements-ctc.txt
ssh lisa '~/.local/share/uv/python/cpython-3.11.13-linux-x86_64-gnu/bin/python3 -m venv ~/sonder-replication/ctc-worker-env'
ssh lisa '~/sonder-replication/ctc-worker-env/bin/python -m pip install --no-cache-dir -r ~/sonder-replication/issue-275-setup/requirements-ctc.txt'
ssh lisa '~/sonder-replication/ctc-worker-env/bin/python -m pip install --no-cache-dir numpy==1.26.4 fastapi==0.121.3 uvicorn==0.38.0 faster-whisper==1.2.1'
```

The requirements file pins the CPU builds of Torch and TorchAudio 2.8.
`faster-whisper` is needed for the anchored planner's speech samples. Before
starting a persistent worker, copy the repository's `worker/` directory to
lisa and choose a `MEDIA_ROOT`. From the directory containing the copied
`worker/`, fetch both the pinned CTC checkpoint and Whisper model into that
root:

```sh
MEDIA_ROOT="$CTC_MEDIA_ROOT" ~/sonder-replication/ctc-worker-env/bin/python worker/download_model.py
```

Start `uvicorn align:app` from the copied `worker/`
directory with `MEDIA_ROOT`, `ALIGNMENT_CTC_DEVICE=cpu` and the private token
set. A GPU worker uses `ALIGNMENT_CTC_DEVICE=cuda`. The installation and gates
do not install or start a persistent worker service.

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

The pool remains off by default. No schema migration is needed. The worker
ran `npx tsc --noEmit`, the focused alignment tests, `npm test`, and the Python
worker tests; the coordinator runs `npm run check -- --ref <commit>` on the
committed revision.
