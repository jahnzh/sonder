#!/usr/bin/env python3
"""A random sample of kept recap claims next to the text they cite, for a person to judge: does the passage say it?

    audit.py <run folder> <book> <books folder> [--assembled] [--n 30] [--seed 1] [--written-only]

Prints each claim with its cited sentence and the sentences around it. For a real book this prints the book's text:
read it on the host, do not commit it. --written-only leaves out claims that are stored notes word for word.
"""
import json, random, sys

args = sys.argv[1:]
def option(name, default):
    return args[args.index(name) + 1] if name in args else default
run, book, library = args[0], args[1], args[2]
rows = json.load(open(f"{run}/{book}.recaps{'.assembled' if '--assembled' in args else ''}.json"))["rows"]
sentences = json.load(open(f"{library}/{book}.json"))["sentences"]
by_id = {s["id"]: s for s in sentences}
claims = [(row, claim) for row in rows for claim in row["claims"] if claim["ok"] and not ("--written-only" in args and claim.get("stored"))]
random.seed(int(option("--seed", "1")))
sample = random.sample(claims, min(int(option("--n", "30")), len(claims)))
print(f"{len(sample)} of {len(claims)} kept claims")
for number, (row, claim) in enumerate(sample, 1):
    cited = by_id[claim["id"]]
    around = sentences[max(0, cited["ord"] - 3):min(row["cutoffOrd"], cited["ord"] + 1) + 1]
    print(f"\n#{number} [{row['position']}, {row['gapDays']} d, {claim['group']}{', stored note' if claim.get('stored') else ''}] {claim['text']}")
    for s in around:
        print(("  >> " if s["id"] == cited["id"] else "     ") + f"[{s['id']}] {s['text'][:400]}")
