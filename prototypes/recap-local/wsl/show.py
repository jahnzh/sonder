#!/usr/bin/env python3
"""Print the stored notes and the recaps of one run folder, for reading: show.py <run folder> <book> [--notes] [--assembled]"""
import json, sys
run, book = sys.argv[1], sys.argv[2]
if "--notes" in sys.argv:
    s = json.load(open(f"{run}/{book}.states.json"))
    for u in s["units"]:
        print("--", u["title"], "| retired", u["retired"], "| dropped", [(d["reason"], d["id"], d["quote"][:40]) for d in u["dropped"]])
        for h in u["added"]:
            n = s["notes"][h]
            print("   ", h, n["weight"], n["id"], "|", n["text"], "| Q:", n["quote"][:50])
r = json.load(open(f"{run}/{book}.recaps{'.assembled' if '--assembled' in sys.argv else ''}.json"))
for row in r["rows"]:
    t = row["timing"]
    print(f"\n== {row['position']} ({row['cutoff']}), {row['gapDays']} d: {row['words']} words, target {row['target']}, kept {row['kept']}/{row['offered']}, dropped {row['dropped']}, repeats {row['duplicates']}, exact {row['exact']}, repaired {row['repaired']}; notes in {row['input']['notes']}, raw {row['input']['rawSentences']}; tokens {t['promptTokens']}+{t['cachedTokens']} cached / {t['outputTokens']}; {round(t['ms'])} ms")
    print(row["text"])
    for c in row["claims"]:
        if not c["ok"]:
            print("  LEFT OUT", c["reason"], c["id"], "|", c["text"], "| Q:", c["quote"][:70])
    for f in row.get("leaks", []) + row.get("injection", []):
        print("  FLAG", f["name"], "| certain" if f["certain"] else "| to read", "|", f["line"])
    if row.get("bareMara"):
        print("  BARE MARA", row["bareMara"])
    if row.get("foreshadowing"):
        print("  FORESHADOWING", row["foreshadowing"])
