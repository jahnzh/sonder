"""Score the independent 128-utterance labelled sample through the worker HTTP API."""
import argparse
import json
import math
import os
import statistics
import sys
import urllib.request
from pathlib import Path

from ctc_acoustic import ENGINE


def score(predictions, truth):
    if len(truth) != 128 or [item["index"] for item in truth] != list(range(128)):
        raise ValueError("Expected the 128 sequential labelled utterances.")
    by_index = {}
    for item in predictions:
        index = item["index"]
        if index in by_index or not isinstance(index, int) or not 0 <= index < len(truth):
            raise ValueError("Duplicate or invalid predicted interval index.")
        if all(math.isfinite(item[key]) for key in ("start", "end")) and item["end"] > item["start"]:
            by_index[index] = item
    endpoint_errors = []
    sentence_pass = 0
    for expected in truth:
        actual = by_index.get(expected["index"])
        if actual:
            errors = [abs(actual[key] - expected[key]) for key in ("start", "end")]
            endpoint_errors.extend(errors)
            sentence_pass += max(errors) <= 0.250 + 1e-9
    transitions = []
    for left, right in zip(truth, truth[1:]):
        a, b = by_index.get(left["index"]), by_index.get(right["index"])
        if a and b and a["end"] <= b["start"] + 1e-8:
            transitions.append(abs((a["end"] + b["start"] - left["end"] - right["start"]) / 2))
    transition_pass = sum(error <= 0.250 + 1e-9 for error in transitions)
    maximum = max(endpoint_errors + transitions, default=float("inf"))
    result = {"covered": len(by_index), "missing": 128 - len(by_index), "sentence_pass": sentence_pass,
              "transitions_covered": len(transitions), "transition_pass": transition_pass,
              "max_error_ms": maximum * 1000,
              "median_endpoint_ms": statistics.median(endpoint_errors) * 1000 if endpoint_errors else None}
    result["passed"] = (result["covered"] == 128 and sentence_pass == 128 and len(transitions) == 127
                        and transition_pass == 127 and maximum <= 1.0 + 1e-9)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Worker base URL, e.g. http://127.0.0.1:3012")
    parser.add_argument("--audio", required=True, help="Absolute WAV path under the worker MEDIA_ROOT")
    parser.add_argument("--output", required=True, help="Worker output path under MEDIA_ROOT/alignment")
    parser.add_argument("--reference", required=True, type=Path, help="Trial inputs/reference.json")
    parser.add_argument("--gold", required=True, type=Path, help="Independent trial inputs/gold.json")
    args = parser.parse_args()
    token = os.environ.get("ALIGNMENT_WORKER_TOKEN")
    if not token:
        parser.error("Set ALIGNMENT_WORKER_TOKEN in the environment.")
    reference = json.loads(args.reference.read_text())
    gold = json.loads(args.gold.read_text())
    if reference["sentences"] != [row["text"] for row in gold["sentences"]]:
        raise ValueError("Reference and gold utterances differ.")
    payload = {"token": token, "audio": args.audio, "output": args.output, "engine": "ctc", "language": "eng",
               "fragments": reference["sentences"], "start": 0, "duration": reference["duration"]}
    request = urllib.request.Request(args.url.rstrip("/") + "/align", json.dumps(payload).encode(),
                                     {"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=1800) as response:
        result = json.load(response)
    if result.get("engine") != ENGINE or result.get("outcome") not in {"mapped", "partial", "unsynced"}:
        raise ValueError("Worker did not return a CTC alignment result.")
    metrics = score(result["intervals"], gold["sentences"])
    print("| Metric | Result | Required |")
    print("| --- | ---: | ---: |")
    print(f"| Covered utterances | {metrics['covered']}/128 | 128/128 |")
    print(f"| Both sentence endpoints ≤250 ms | {metrics['sentence_pass']}/128 | 128/128 |")
    print(f"| Transition midpoints ≤250 ms | {metrics['transition_pass']}/127 | 127/127 |")
    print(f"| Missing utterances | {metrics['missing']} | 0 |")
    print(f"| Maximum endpoint or transition error | {metrics['max_error_ms']:.1f} ms | ≤1000 ms |")
    print(f"\nGate: {'PASS' if metrics['passed'] else 'FAIL'}; engine: {result['engine']}; outcome: {result['outcome']}")
    return 0 if metrics["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
