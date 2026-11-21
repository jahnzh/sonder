#!/usr/bin/env python3
"""One recap of a run as Markdown: sample.py <run folder> <book> <position> <gap days> [--cite] [--assembled]

--cite lists the kept claims with their sentence ids and quotes (use it for the invented fixture only: for a real
book the quotes are the book's text). Without it only the recap's own words are printed.
"""
import json, sys

run, book, position, gap = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
rows = json.load(open(f"{run}/{book}.recaps{'.assembled' if '--assembled' in sys.argv else ''}.json"))["rows"]
row = next(r for r in rows if r["position"].startswith(position) and r["gapDays"] == gap)
kept = [c for c in row["claims"] if c["ok"]]
left = [c for c in row["claims"] if not c["ok"]]
print(f"*{row['position']} ({row['cutoff']}), away {gap} days: {row['words']} words (band {row['target'][0]}–{row['target'][1]}), "
      f"{len(kept)} of {row['offered']} claims kept, {row['dropped']} dropped by the citation check, {row['duplicates']} repeats left out, {row['timing']['ms'] / 1000:.1f} s.*\n")
if "--cite" in sys.argv:
    for claim in kept:
        print(f"- {claim['text']} `{claim['id']}` “{claim['quote']}”")
    for claim in left:
        print(f"- ~~{claim['text']}~~ ({claim['reason']}: `{claim['id']}` “{claim['quote']}”)")
else:
    for paragraph in row["text"].split("\n\n"):
        print("> " + paragraph + "\n>")
