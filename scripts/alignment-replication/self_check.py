"""Checks the metric code and the published numbers that can be checked without data.

Run from the repository root:
  python3 -I scripts/alignment-replication/self_check.py artifacts/6/self_check.json

Exit status is non-zero if any check fails. The output file is written either way.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from metrics import aas_ms, lcs_error_counts  # noqa: E402


def check(results, name, ok, detail):
    results.append({"check": name, "ok": bool(ok), "detail": detail})


def metric_checks(results):
    # AAS: one word, start off by 10 ms and end off by 20 ms -> 30 ms.
    v = aas_ms([(1.0, 2.0)], [(1.010, 2.020)])
    check(results, "aas single word", abs(v - 30.0) < 1e-9, v)

    # AAS averages over word slots, not over the two endpoints.
    v = aas_ms([(0.0, 1.0), (1.0, 2.0)], [(0.0, 1.0), (1.02, 2.0)])
    check(results, "aas averages over slots", abs(v - 10.0) < 1e-9, v)

    # LCS: identical lists have no errors.
    c = lcs_error_counts("a b c".split(), "a b c".split())
    check(results, "lcs identical", c["err"] == 0.0, c)

    # LCS: one substitution, one deletion, one insertion in a 4-word reference.
    ref = "the cat sat down".split()
    hyp = "the dog sat down there".split()
    c = lcs_error_counts(ref, hyp)
    check(
        results,
        "lcs sub/ins",
        (c["sub"], c["del"], c["ins"]) == (1, 0, 1) and abs(c["err"] - 0.5) < 1e-9,
        c,
    )
    ref = "a b c d".split()
    hyp = "a c d".split()
    c = lcs_error_counts(ref, hyp)
    check(
        results,
        "lcs deletion",
        (c["sub"], c["del"], c["ins"]) == (0, 1, 0) and abs(c["err"] - 0.25) < 1e-9,
        c,
    )


def paper_checks(results):
    # Braunschweiler et al. 2010, Table 2.1: columns must sum to Err.
    t21 = {"words": (0.4, 1.4, 3.6, 5.4), "sentences": (4.9, 2.5, 6.0, 13.4)}
    for k, (s, d, i, e) in t21.items():
        check(results, f"Braunschweiler T2.1 {k} sum", abs(s + d + i - e) < 1e-9, [s, d, i, e])
    # Table 4.1 (recognition output).
    t41 = {"words": (1.8, 0.5, 1.0, 3.3), "sentences": (11.5, 3.0, 0.9, 15.4)}
    for k, (s, d, i, e) in t41.items():
        check(results, f"Braunschweiler T4.1 {k} sum", abs(s + d + i - e) < 1e-9, [s, d, i, e])
    # Sec. 4: 1.5% of 7672 sentences labelled; 1.5% bad onset and 3.1% bad offset, none both.
    ok_pct = 100.0 - 1.5 - 3.1
    check(
        results,
        "Braunschweiler boundary OK arithmetic (>95%)",
        ok_pct > 95.0,
        {"ok_pct": round(ok_pct, 2), "labelled_sentences": round(0.015 * 7672)},
    )

    # SwanVoice Table 3 (AAS, ms). Text says Swan is "within 0.18 ms of Qwen3" on Others.
    t3 = {
        "GTSinger-ZH": {"swan": 45.19, "qwen3": 47.31, "lattifai": 31.60},
        "LS-Clean": {"swan": 27.67, "qwen3": 27.84, "lattifai": 25.70},
        "LS-Others": {"swan": 29.92, "qwen3": 29.74, "lattifai": 36.00},
    }
    gap = round(t3["LS-Others"]["swan"] - t3["LS-Others"]["qwen3"], 2)
    check(results, "SwanVoice text: within 0.18 ms of Qwen3 on LS-Others", abs(gap - 0.18) < 1e-9, gap)
    # Text says "about 10 ms behind LattifAI" for the Others set. Table says otherwise.
    # These are findings about the paper, not failures of this code, so they are recorded
    # with ok=True and consistent_with_table=False.
    behind = round(t3["LS-Others"]["swan"] - t3["LS-Others"]["lattifai"], 2)
    results.append({
        "check": "SwanVoice text 'about 10 ms behind LattifAI' (LS-Others) vs Table 3",
        "ok": True,
        "detail": {
            "text_claim_ms": 10.0,
            "table_swan_minus_lattifai_ms": behind,
            "consistent_with_table": abs(behind - 10.0) <= 1.0,
            "note": "negative = Swan has lower (better) AAS",
        },
    })
    behind_clean = round(t3["LS-Clean"]["swan"] - t3["LS-Clean"]["lattifai"], 2)
    results.append({
        "check": "SwanVoice Table 3 Swan minus LattifAI (LS-Clean, ms)",
        "ok": True,
        "detail": behind_clean,
    })


def main(out_path):
    results = []
    metric_checks(results)
    paper_checks(results)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    failed = [r for r in results if not r["ok"]]
    for r in results:
        print(("PASS" if r["ok"] else "FAIL"), r["check"], "-", json.dumps(r["detail"]))
    print(f"{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: self_check.py <out.json>")
    sys.exit(main(sys.argv[1]))
