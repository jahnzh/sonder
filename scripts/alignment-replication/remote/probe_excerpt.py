"""Prints Whisper tiny word timestamps for a short excerpt, to see what is spoken where.

Diagnostic only; uses the worker's own anchors.transcribe_excerpt (CPU int8, local model).
  python -I probe_excerpt.py <run-dir> <worker-dir> <audio.wav> <start-s> <duration-s>
"""
import os
import sys
from pathlib import Path

run_dir, worker_dir, audio, start, duration = sys.argv[1:6]
os.environ["MEDIA_ROOT"] = run_dir
sys.path.insert(0, worker_dir)
import anchors  # noqa: E402

words = anchors.transcribe_excerpt(Path(audio), Path(run_dir) / "alignment", float(start), float(duration), "eng")
line = []
for w in words:
    line.append(f"{w['text'].strip()}@{w['start']:.1f}")
print(" ".join(line))
