#!/usr/bin/env python3
"""Numbers of the measured runs, as Markdown tables and as JSON without any book text.

    report.py <runs folder> <label> [<label> ...] [--json <out.json>]

Reads what measure.sh wrote for each label: vram.json, <book>.states.json and <book>.recaps.json.
"""
import json, os, sys

args = sys.argv[1:]
out = None
if "--json" in args:
    at = args.index("--json")
    out = args[at + 1]
    del args[at:at + 2]
runs, labels = args[0], args[1:]
books = ["fixture", "dcc1"]


def rate(tokens, ms):
    return round(tokens / ms * 1000) if ms else 0


def precompute(states):
    units = states["units"]
    reasons = {}
    for unit in units:
        for dropped in unit["dropped"]:
            reasons[dropped["reason"]] = reasons.get(dropped["reason"], 0) + 1
    offered = sum(unit["offered"] for unit in units)
    dropped = sum(len(unit["dropped"]) for unit in units)
    return {
        "units": len(units),
        "seconds": round(sum(unit["ms"] for unit in units) / 1000, 1),
        "promptTokens": sum(unit["promptTokens"] for unit in units),
        "cachedTokens": sum(unit["cachedTokens"] for unit in units),
        "outputTokens": sum(unit["outputTokens"] for unit in units),
        "promptPerSecond": rate(sum(unit["promptTokens"] for unit in units), sum(unit["promptMs"] for unit in units)),
        "outputPerSecond": rate(sum(unit["outputTokens"] for unit in units), sum(unit["outputMs"] for unit in units)),
        "notesOffered": offered,
        "notesDropped": dropped,
        "notesDroppedShare": round(dropped / offered, 3) if offered else 0,
        "notesRepaired": sum(unit["repaired"] for unit in units),
        "dropReasons": reasons,
        "retries": sum(unit["retries"] for unit in units),
        "serverErrors": sum(unit.get("serverErrors", 0) for unit in units),
        "failedUnits": sum(1 for unit in units if unit.get("failed")),
        "slowestUnitSeconds": round(max(unit["ms"] for unit in units) / 1000, 1),
    }


def recaps(rows):
    offered = sum(row["offered"] for row in rows)
    dropped = sum(row["dropped"] for row in rows)
    kept = sum(row["kept"] for row in rows)
    reasons = {}
    for row in rows:
        for reason, count in row["reasons"].items():
            reasons[reason] = reasons.get(reason, 0) + count
    return {
        "recaps": len(rows),
        "claimsOffered": offered,
        "claimsDropped": dropped,
        "claimsDroppedShare": round(dropped / offered, 3) if offered else 0,
        "claimsRepeated": sum(row["duplicates"] for row in rows),
        "claimsKept": kept,
        "keptExact": sum(row["exact"] for row in rows),
        "keptRepaired": sum(row["repaired"] for row in rows),
        "dropReasons": reasons,
        "secondsEach": [round(row["timing"]["ms"] / 1000, 1) for row in rows],
        "secondsMean": round(sum(row["timing"]["ms"] for row in rows) / len(rows) / 1000, 1),
        "secondsMax": round(max(row["timing"]["ms"] for row in rows) / 1000, 1),
        "promptPerSecond": rate(sum(row["timing"]["promptTokens"] for row in rows), sum(row["timing"]["promptMs"] for row in rows)),
        "outputPerSecond": rate(sum(row["timing"]["outputTokens"] for row in rows), sum(row["timing"]["outputMs"] for row in rows)),
        "words": [[row["position"], row["gapDays"], row["words"], row["target"], row["bandLimitedByText"]] for row in rows],
        "inTarget": sum(1 for row in rows if row["target"][0] <= row["words"] <= row["target"][1]),
        "leakFlags": sum(len(row.get("leaks", [])) for row in rows),
        "certainLeakFlags": sum(1 for row in rows for flag in row.get("leaks", []) if flag["certain"]),
        "injectionFlags": sum(len(row.get("injection", [])) for row in rows),
        "bareMaraLines": sum(len(row.get("bareMara", [])) for row in rows),
        "foreshadowingLines": sum(len(row.get("foreshadowing", [])) for row in rows),
        "retries": sum(row["timing"]["retries"] for row in rows),
        "serverErrors": sum(row["timing"].get("serverErrors", 0) for row in rows),
    }


report = {}
for label in labels:
    folder = os.path.join(runs, label)
    entry = {"vram": json.load(open(os.path.join(folder, "vram.json")))}
    if os.path.exists(os.path.join(folder, "vram.recaps.json")):
        entry["vramRecaps"] = json.load(open(os.path.join(folder, "vram.recaps.json")))
    for book in books:
        states_path, recaps_path = os.path.join(folder, f"{book}.states.json"), os.path.join(folder, f"{book}.recaps.json")
        if not os.path.exists(states_path):
            continue
        entry[book] = {"precompute": precompute(json.load(open(states_path)))}
        if os.path.exists(recaps_path):
            entry[book]["recaps"] = recaps(json.load(open(recaps_path))["rows"])
        assembled_path = os.path.join(folder, f"{book}.recaps.assembled.json")
        if os.path.exists(assembled_path):
            rows = json.load(open(assembled_path))["rows"]
            entry[book]["assembled"] = recaps(rows)
            entry[book]["assembled"]["fromStoredNotes"] = sum(row.get("fromStoredNotes", 0) for row in rows)
    report[label] = entry

if out:
    json.dump(report, open(out, "w"), indent=2)

print("| Configuration | GPU memory taken (peak) | Reading tok/s | Writing tok/s | Whole book | Recap latency (mean, max) | Citations dropped | Repeats left out |")
print("| --- | --- | --- | --- | --- | --- | --- | --- |")
for label, entry in report.items():
    vram = entry["vram"]
    book = entry.get("dcc1") or entry["fixture"]
    pre, rec = book["precompute"], book.get("recaps")
    print(f"| {label} | {vram['peakMiB'] - vram['baselineMiB']} MiB ({vram['peakMiB']} of 8192 with the desktop's {vram['baselineMiB']}) | {pre['promptPerSecond']} | {pre['outputPerSecond']} | {pre['seconds']} s, {pre['units']} units | "
          + (f"{rec['secondsMean']} s, {rec['secondsMax']} s | {rec['claimsDropped']}/{rec['claimsOffered']} ({rec['claimsDroppedShare']:.1%}) | {rec['claimsRepeated']} |" if rec else "– | – | – |"))
print()
for book in books:
    print(f"### {book}")
    print("| Configuration | Notes offered | Notes dropped | Repaired | Retries | Recap claims offered | Dropped | Repeats | Kept exact / kept | Words in target | Leak flags (certain) | Injection flags |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for label, entry in report.items():
        if book not in entry:
            continue
        pre, rec = entry[book]["precompute"], entry[book].get("recaps")
        line = f"| {label} | {pre['notesOffered']} | {pre['notesDropped']} ({pre['notesDroppedShare']:.1%}) {pre['dropReasons'] or ''} | {pre['notesRepaired']} | {pre['retries']} | "
        line += (f"{rec['claimsOffered']} | {rec['claimsDropped']} ({rec['claimsDroppedShare']:.1%}) {rec['dropReasons'] or ''} | {rec['claimsRepeated']} | {rec['keptExact']} / {rec['claimsKept']} | {rec['inTarget']} of {rec['recaps']} | {rec['leakFlags']} ({rec['certainLeakFlags']}) | {rec['injectionFlags']} |" if rec else "– | – | – | – | – | – | – |")
        print(line)
    print()

print("### Recaps by mode")
print("| Configuration | Book | Mode | Latency mean, max (7 d; 70 d) | Writing tok/s | Claims | From stored notes | Dropped by the citation check | Repeats left out | Kept exact / kept | In the word band |")
print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
for label, entry in report.items():
    for book in books:
        for mode, key in (("written", "recaps"), ("assembled", "assembled")):
            rec = entry.get(book, {}).get(key)
            if not rec:
                continue
            short = [seconds for seconds, word in zip(rec["secondsEach"], rec["words"]) if word[1] == 7]
            long = [seconds for seconds, word in zip(rec["secondsEach"], rec["words"]) if word[1] != 7]
            print(f"| {label} | {book} | {mode} | {rec['secondsMean']} s, {rec['secondsMax']} s ({sum(short) / len(short):.1f} s; {sum(long) / len(long):.1f} s) | {rec['outputPerSecond']} | {rec['claimsOffered']} | {rec.get('fromStoredNotes', 0)} | "
                  f"{rec['claimsDropped']} ({rec['claimsDroppedShare']:.1%}) | {rec['claimsRepeated']} | {rec['keptExact']} / {rec['claimsKept']} | {rec['inTarget']} of {rec['recaps']} |")
