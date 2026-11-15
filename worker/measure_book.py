"""Run one recording through a worker's whole-book job API and compare the map (#402 measurements).

Research script: it is not part of the worker image. It talks to a worker over HTTP like the server
will, so a run measures the real interface. Output files hold ids and timings only, never book text.

  measure_book.py run --url URL --job-id ID --book book.json --tracks tracks.json --track-dir DIR \
      --out result.json [--recording ID]
  measure_book.py compare --mine result.json --reference map.json [--reference-offsets decode.json] \
      [--cuts-from intervals-v2.json] --out compare.json
"""
import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def call(url, method="GET", body=None, token=None, timeout=120):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data, method=method, headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {token or os.environ['ALIGNMENT_WORKER_TOKEN']}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        except ValueError:
            return error.code, {"detail": error.reason}


def run_job(base, body, poll=2.0, log=lambda line: print(line, flush=True), timeout=6 * 3600, keep=False):
    """Start a job, poll it to the end and fetch the result. Returns (result, last status, wall seconds)."""
    started = time.monotonic()
    code, status = call(f"{base}/book-jobs", "POST", body)
    if code != 202:
        raise RuntimeError(f"start failed: {code} {status}")
    last = None
    while True:
        code, status = call(f"{base}/book-jobs/{body['jobId']}")
        if code != 200:
            raise RuntimeError(f"status failed: {code} {status}")
        line = (status["state"], json.dumps(status.get("progress", {}), sort_keys=True))
        if line != last:
            log(f"{time.monotonic() - started:8.1f} s {status['state']} {line[1]}")
            last = line
        if status["state"] in ("done", "failed", "cancelled"):
            break
        if time.monotonic() - started > timeout:
            raise RuntimeError("timed out")
        time.sleep(poll)
    wall = time.monotonic() - started
    if status["state"] != "done":
        raise RuntimeError(f"job ended {status['state']}: {status.get('error')}")
    if keep == "unfetched":  # leave the session (emissions included) until it goes idle
        return {"unfetched": True}, status, wall
    code, result = call(f"{base}/book-jobs/{body['jobId']}/result")
    if code != 200:
        raise RuntimeError(f"result failed: {code} {result}")
    if not keep:  # --keep leaves the job's groups/ on the worker for diagnosis (removed when idle)
        call(f"{base}/book-jobs/{body['jobId']}", "DELETE")
    return result, status, wall


def run(args):
    book = json.loads(args.book.read_text())
    tracks = json.loads(args.tracks.read_text())
    body = {"jobId": args.job_id, "recordingId": args.recording or args.job_id, "language": "eng",
            "sentences": [{"id": p["id"], "section": p.get("section", 0), "text": p["text"]} for p in book["paragraphs"]],
            "tracks": [{"id": t["id"], "audio": str(args.track_dir / t["id"]), "duration": t["listed_duration"]}
                       for t in tracks]}
    result, status, wall = run_job(args.url.rstrip("/"), body, keep="unfetched" if args.no_fetch else args.keep)
    if args.no_fetch:
        print(json.dumps({"jobId": body["jobId"], "wallSeconds": wall, "state": status["state"]}), flush=True)
        return
    result["wallSeconds"] = wall
    result["finalStatus"] = {k: v for k, v in status.items() if k != "progress"}
    result["finalStatus"]["progress"] = status.get("progress")
    args.out.write_text(json.dumps(result))
    summary = {k: result.get(k) for k in ("outcome", "sentences", "mapped", "wallSeconds", "stageTimings", "encode")}
    summary["groups"] = result["stats"]["groups"]
    summary["durationChecks"] = [t for t in result["tracks"] if t.get("durationOk") is False]
    print(json.dumps(summary), flush=True)


def starts_by_id(intervals, offsets=None):
    """paragraphId -> (trackId, start in track seconds, book seconds when offsets are known)."""
    out = {}
    for item in intervals:
        offset = (offsets or {}).get(item["trackId"])
        out[item["paragraphId"]] = (item["trackId"], item["start"], None if offset is None else offset + item["start"])
    return out


def compare(args):
    mine_file = json.loads(args.mine.read_text())
    reference_file = json.loads(args.reference.read_text())
    mine_offsets, total = {}, 0.0
    for track in mine_file["tracks"]:
        mine_offsets[track["id"]] = total
        total += track["decodedSeconds"]
    reference_offsets = None
    if args.reference_offsets:
        decoded = json.loads(args.reference_offsets.read_text())
        reference_offsets = {t["id"]: t["sample_start"] / 16000 for t in decoded["tracks"]}
    mine = starts_by_id(mine_file["intervals"], mine_offsets)
    reference = starts_by_id(reference_file["intervals"], reference_offsets)
    both = sorted(set(mine) & set(reference))
    diffs, other_track = [], 0
    for key in both:
        if mine[key][0] != reference[key][0]:
            other_track += 1
            continue
        diffs.append(abs(mine[key][1] - reference[key][1]))
    diffs.sort()
    sentences = mine_file.get("sentences") or reference_file.get("sentences")
    result = {"reference": str(args.reference), "referenceMapped": len(reference), "mineMapped": len(mine),
              "both": len(both), "onlyReference": len(set(reference) - set(mine)), "onlyMine": len(set(mine) - set(reference)),
              "agreementOfReference": len(both) / max(1, len(reference)), "otherTrack": other_track,
              "medianMs": 1000 * statistics.median(diffs) if diffs else None,
              "p90Ms": 1000 * diffs[int(0.9 * (len(diffs) - 1))] if diffs else None,
              "within250ms": sum(d <= 0.25 for d in diffs) / max(1, len(diffs)),
              "within1s": sum(d <= 1.0 for d in diffs) / max(1, len(diffs)),
              "over10s": sum(d > 10 for d in diffs),
              "mineFractionOfBook": len(mine) / sentences if sentences else None,
              "referenceFractionOfBook": len(reference) / sentences if sentences else None}
    # Where the two maps differ: how many of the one-sided sentences lie near a group cut (90 s).
    cuts = {"mine": [s for s in mine_file.get("stats", {}).get("groupStartsSeconds", [])[1:]]}
    if args.cuts_from:
        summary = json.loads(args.cuts_from.read_text()).get("summary", {})
        cuts["reference"] = [row[0] for row in summary.get("group_starts", [])[1:]]

    def near(seconds, positions):
        return seconds is not None and any(abs(seconds - p) <= 90 for p in positions)

    for name, keys, table in (("onlyReference", set(reference) - set(mine), reference),
                              ("onlyMine", set(mine) - set(reference), mine)):
        for side, positions in cuts.items():
            result[f"{name}NearCut_{side}"] = sum(near(table[k][2], positions) for k in keys)
    args.out.write_text(json.dumps(result))
    print(json.dumps(result), flush=True)


def diagnose(args):
    """Seam losses on one job's own emissions: the grouped map against one ungrouped pass.

    The ungrouped pass is the same aligner as one group spanning the book (the v2 path for a book with
    no anchors), so every sentence it keeps and the grouped run does not is lost to the grouping.
    """
    import numpy as np
    import book_align
    from book_job import LABELS
    job = args.job
    request = json.loads((job / "request.json").read_text())
    plan = json.loads((job / "groups" / "plan.json").read_text())
    sentences = [s["text"] for s in request["sentences"]]
    emissions = np.memmap(job / "emissions" / "book.f16", dtype=np.float16, mode="r").reshape(-1, 29)
    longform = book_align.LongForm(emissions, LABELS, sentences)
    groups = {t["index"]: json.loads((job / "groups" / f"{t['index']}.json").read_text()) for t in plan["tasks"]}
    outputs = [{int(k): tuple(v) for k, v in groups[t["index"]]["intervals"].items()} for t in plan["tasks"]]
    grouped, _ = book_align.merge_groups(outputs)
    started = time.monotonic()
    whole = longform.run(0, None, 0, None)
    sequential_seconds = time.monotonic() - started
    grouped_ok = book_align.validate(longform, grouped)
    whole_ok = book_align.validate(longform, whole)
    cuts = [t["aStart"] for t in plan["tasks"][1:]]

    def distance(frame):
        return min((abs(frame - c) for c in cuts), default=None)

    lost = sorted(set(whole_ok) - set(grouped_ok))
    gained = sorted(set(grouped_ok) - set(whole_ok))
    rows = []
    for k in lost:
        trimmed_in = [i for i, g in groups.items() if str(k) in g.get("trimmed", {})]
        kept_in = [i for i, g in groups.items() if str(k) in g["intervals"]]
        if k in grouped:
            why = "rejected by validation"
        elif kept_in:
            why = "dropped as an order conflict"
        elif trimmed_in:
            why = "only in a trimmed seam"
        else:
            why = "not aligned by any group"
        rows.append({"sentence": k, "secondsFromCut": round(distance(whole[k][0]) * 0.02, 1) if cuts else None,
                     "why": why})
    report = {"groups": len(plan["tasks"]), "sequentialSeconds": sequential_seconds,
              "ungroupedAccepted": len(whole_ok), "groupedAccepted": len(grouped_ok),
              "lostToGrouping": len(lost), "gainedByGrouping": len(gained),
              "lostWithin90sOfACut": sum(1 for r in rows if r["secondsFromCut"] is not None and r["secondsFromCut"] <= 90),
              "why": {w: sum(1 for r in rows if r["why"] == w) for w in {r["why"] for r in rows}}, "lost": rows}
    args.out.write_text(json.dumps(report))
    print(json.dumps({k: v for k, v in report.items() if k != "lost"}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("run")
    r.add_argument("--url", required=True)
    r.add_argument("--job-id", required=True)
    r.add_argument("--recording")
    r.add_argument("--book", type=Path, required=True, help="book.json: paragraphs [{id, section, text}]")
    r.add_argument("--tracks", type=Path, required=True, help="tracks.json: [{id, listed_duration}] in order")
    r.add_argument("--track-dir", type=Path, required=True, help="folder under the worker's MEDIA_ROOT")
    r.add_argument("--out", type=Path, required=True)
    r.add_argument("--keep", action="store_true", help="do not delete the job after fetching its result")
    r.add_argument("--no-fetch", action="store_true",
                   help="do not fetch the result: the job keeps its emissions until it is idle (for diagnose)")
    d = sub.add_parser("diagnose", help="on the worker host: grouped against ungrouped on a job's own emissions")
    d.add_argument("--job", type=Path, required=True, help="the job folder under alignment/book-jobs")
    d.add_argument("--out", type=Path, required=True)
    c = sub.add_parser("compare")
    c.add_argument("--mine", type=Path, required=True)
    c.add_argument("--reference", type=Path, required=True, help="a map with intervals [{paragraphId, trackId, start}]")
    c.add_argument("--reference-offsets", type=Path, help="the prototype's decode.json (track sample starts)")
    c.add_argument("--cuts-from", type=Path, help="the prototype's v2 intervals file (summary.group_starts)")
    c.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    {"run": run, "compare": compare, "diagnose": diagnose}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
