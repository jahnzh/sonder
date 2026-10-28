"""Runs the Sonder worker's known-text alignment (worker/align.py, `align()`) on one chapter.

The worker module is imported from the repository clone and called directly, so
the code path is the one /align runs in production (ffmpeg -> aeneas, then the
short Whisper tiny excerpt check). Nothing listens on a port and no production
service is contacted.

Run with the venv python from the run directory:
  python -I align_chapter.py <run-dir> <worker-dir> <audio.wav> <fragments.json> \
      sentences|words <out.json>
"""
import json
import os
import sys
import time
import wave
from math import ceil
from pathlib import Path

run_dir, worker_dir, audio, fragments_path, level, out_path = sys.argv[1:7]
run_dir = Path(run_dir).resolve()
os.environ["MEDIA_ROOT"] = str(run_dir)  # the worker only reads/writes under MEDIA_ROOT
os.environ["ALIGNMENT_WORKER_TOKEN"] = "local-replication"
sys.path.insert(0, worker_dir)
import align  # noqa: E402

fragments = json.load(open(fragments_path))
texts = [item["text"] for item in fragments[level]]
with wave.open(audio) as w:
    duration = w.getnframes() / w.getframerate()

request = align.AlignRequest(
    token="local-replication",
    audio=str(Path(audio).resolve()),
    output=str(run_dir / "alignment" / "runs" / f"{level}.json"),
    fragments=texts,
    language="eng",
    start=0,
    duration=ceil(duration),
)
started = time.monotonic()
result = align.align(request)
wall = time.monotonic() - started
result["fragmentCount"] = len(texts)
result["audioSeconds"] = duration
result["wallSeconds"] = wall
Path(out_path).write_text(json.dumps(result))
quality = result.get("quality") or {}
print(json.dumps({
    "level": level, "fragments": len(texts), "intervals": len(result["intervals"]),
    "workerElapsedSeconds": result["elapsedSeconds"], "wallSeconds": wall,
    "workerPeakMemoryMB": result["peakMemoryMB"],
    "excerptMatchScore": (quality.get("match") or {}).get("score"),
}))
