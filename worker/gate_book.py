"""The 128-utterance labelled gate through the whole-book job API (#402). Research script, not in the image.

One job aligns the labelled sample's 128 reference sentences against its audio, a second job the eight
unrelated sentences of gate_ctc. The map is scored with gate_ctc.score unchanged; first and last kept
means utterances 0 and 127 are mapped, and the unrelated job must map nothing.

  ALIGNMENT_WORKER_TOKEN=... gate_book.py --url http://127.0.0.1:3099 --audio /media/.../timit.wav \
      --reference reference.json --gold gold.json [--out gate.json]
"""
import argparse
import json
import sys
import time
from pathlib import Path

from gate_ctc import UNRELATED, score
from measure_book import run_job


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True)
    parser.add_argument("--audio", required=True, help="absolute path of the sample under the worker's MEDIA_ROOT")
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--gold", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    reference = json.loads(args.reference.read_text())
    gold = json.loads(args.gold.read_text())
    if reference["sentences"] != [row["text"] for row in gold["sentences"]]:
        raise ValueError("Reference and gold utterances differ.")
    base = args.url.rstrip("/")
    stamp = str(int(time.time()))
    track = [{"id": "timit", "audio": args.audio, "duration": reference["duration"]}]

    def body(name, texts):
        return {"jobId": f"gate-{name}-{stamp}", "recordingId": "labelled-gate", "language": "eng",
                "sentences": [{"id": f"u{i}", "section": 0, "text": text} for i, text in enumerate(texts)],
                "tracks": track}

    result, _status, wall = run_job(base, body("labelled", reference["sentences"]), poll=0.5, log=lambda line: None)
    unrelated, _status, unrelated_wall = run_job(base, body("unrelated", UNRELATED), poll=0.5, log=lambda line: None)
    predictions = [{"index": int(item["paragraphId"][1:]), "start": item["start"], "end": item["end"]}
                   for item in result["intervals"]]
    metrics = score(predictions, gold["sentences"])
    indices = {p["index"] for p in predictions}
    metrics["first_kept"] = 0 in indices
    metrics["last_kept"] = len(gold["sentences"]) - 1 in indices
    metrics["unrelated_unsynced"] = unrelated["outcome"] == "unsynced" and unrelated["intervals"] == []
    metrics["passed_core"] = metrics["passed"]
    metrics["passed"] = (metrics["passed"] and metrics["first_kept"] and metrics["last_kept"]
                         and metrics["unrelated_unsynced"])
    report = {**metrics, "engine": result["engine"], "outcome": result["outcome"], "wallSeconds": wall,
              "unrelatedWallSeconds": unrelated_wall, "stageTimings": result.get("stageTimings"),
              "encode": result.get("encode"), "stats": result.get("stats"), "tracks": result.get("tracks")}
    if args.out:
        args.out.write_text(json.dumps(report))
    print("| Metric | Result | Required |")
    print("| --- | ---: | ---: |")
    print(f"| Covered utterances | {metrics['covered']}/128 | 128/128 |")
    print(f"| Both sentence endpoints ≤250 ms | {metrics['sentence_pass']}/128 | 128/128 |")
    print(f"| Transition midpoints ≤250 ms | {metrics['transition_pass']}/{metrics['transitions_covered']} | 127/127 |")
    print(f"| Maximum endpoint or transition error | {metrics['max_error_ms']:.1f} ms | ≤1000 ms |")
    print(f"| First / last kept | {metrics['first_kept']} / {metrics['last_kept']} | yes |")
    print(f"| Unrelated text left unsynced | {metrics['unrelated_unsynced']} | yes |")
    print(f"\nGate: {'PASS' if metrics['passed'] else 'FAIL'}; engine: {result['engine']}; "
          f"wall {wall:.1f} s + {unrelated_wall:.1f} s", flush=True)
    return 0 if metrics["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
