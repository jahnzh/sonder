"""Measure the whole-book encode on one host's CPU (#913): seconds of audio encoded per wall second for each
torch thread count and batch, and how far each setting's emissions are from the first one's.

Research script: it is not part of the worker's service. It decodes a stretch of a recording the way a book
job does (`book_audio.decode_command`) and encodes it with `book_encode.encode_tracks` and the pinned model,
so a run measures the worker's own code. Output holds timings and emission differences only.

  measure_encode.py --alignment MEDIA_ROOT/alignment --audio FILE --start S --seconds N --out DIR \
      [--threads 6,10,20] [--batch 1] [--keep]
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # the worker's modules, also under python -I

def decode(audio, start, seconds, out):
    from book_audio import SAMPLE_RATE, decode_command
    pcm = out / f"slice-{start}-{seconds}.pcm"
    if not pcm.is_file():
        command = decode_command(audio, pcm, int(start * SAMPLE_RATE), int((start + seconds) * SAMPLE_RATE))
        subprocess.run(command, check=True)
    return pcm, pcm.stat().st_size // 2


def compare(reference, other):
    """Emission differences of two `<index>.f16` files (float16 log-probabilities over 29 labels)."""
    import numpy as np
    a = np.fromfile(reference, dtype=np.float16).reshape(-1, 29).astype(np.float32)
    b = np.fromfile(other, dtype=np.float16).reshape(-1, 29).astype(np.float32)
    if a.shape != b.shape:
        return {"frames": [len(a), len(b)]}
    return {"frames": len(a), "identical": bool(np.array_equal(a, b)),
            "argmaxAgreement": float((a.argmax(1) == b.argmax(1)).mean()),
            "maxAbsLogProb": float(np.abs(a - b).max()),
            "maxAbsProb": float(np.abs(np.exp(a) - np.exp(b)).max())}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--alignment", required=True, help="the worker's MEDIA_ROOT/alignment (the model)")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--seconds", type=float, default=300)
    parser.add_argument("--out", required=True)
    parser.add_argument("--threads", default="6,10,20", help="comma-separated torch thread counts")
    parser.add_argument("--batch", default="1", help="comma-separated windows per batch")
    parser.add_argument("--keep", action="store_true", help="keep the emissions and the decoded stretch")
    args = parser.parse_args(argv)
    from book_encode import encode_tracks
    from ctc_acoustic import AcousticModel
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    pcm, samples = decode(args.audio, args.start, args.seconds, out)
    model = AcousticModel(Path(args.alignment))
    track = {"index": 0, "pcm": str(pcm), "samples": samples}
    reference = None
    for batch in [int(b) for b in args.batch.split(",")]:
        for threads in [int(t) for t in args.threads.split(",")]:
            folder = out / f"t{threads}-b{batch}"
            started = time.monotonic()
            stats = encode_tracks(model, [track], folder, None, batch_size=batch,
                                  threads=lambda: threads)
            row = {"threads": threads, "batch": batch, "audioSeconds": stats["audioSeconds"],
                   "encodeSeconds": round(stats["encodeSeconds"], 2), "realtime": round(stats["realtime"], 3),
                   "wallSeconds": round(time.monotonic() - started, 2), "load": os.getloadavg()}
            emissions = folder / "0.f16"
            if reference is None:
                reference = emissions
            else:
                row["versusFirst"] = compare(reference, emissions)
            print(json.dumps(row), flush=True)
    if not args.keep:
        for path in out.glob("t*-b*/*"):
            if path.parent != reference.parent:
                path.unlink()
        pcm.unlink()
    return 0


if __name__ == "__main__":
    sys.exit(main())
