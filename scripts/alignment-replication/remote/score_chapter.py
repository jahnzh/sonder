"""Scores Sonder worker alignments of one chapter against the Parallel Audiobook Corpus ctm.

The corpus word alignments are machine output (Bell & Renals WFST, per the corpus
README), so these figures measure agreement with another aligner, not error
against ground truth.

Reference: ctm words with absolute times. The README says the utterance offsets in
the `seg-A:B` field are in 100 ms units; the data only fit the audio length if they
are 10 ms units, which this script checks and uses.

Hypothesis: the known text the worker was given (word run and sentence run).

Run with a stdlib-only python, isolated:  python -I score_chapter.py --ctm ... --out ...
"""
import argparse
import json
import os
import re
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from metrics import aas_ms, lcs_alignment, lcs_error_counts  # noqa: E402

TOLERANCES = (0.1, 0.25, 0.5, 1.0)


def norm(token):
    token = token.upper().replace("’", "'")
    return re.sub(r"[^A-Z0-9']", "", token).strip("'")


def read_ctm(path, session):
    words = []
    for line in open(path):
        parts = line.split()
        if len(parts) != 5 or f"ses-{session}_" not in parts[0]:
            continue
        seg_start = int(parts[0].split("seg-")[1].split(":")[0]) * 0.01
        start = seg_start + float(parts[2])
        words.append((norm(parts[4]), start, start + float(parts[3])))
    return [w for w in words if w[0]]


def parse_time(path):
    text = open(path).read()
    clock = re.search(r"Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): ([\d:.]+)", text).group(1)
    seconds = 0.0
    for piece in clock.split(":"):
        seconds = seconds * 60 + float(piece)
    rss = int(re.search(r"Maximum resident set size \(kbytes\): (\d+)", text).group(1))
    return {"wallSeconds": seconds, "peakRssMB": rss / 1024}


def spread(errors):
    errors = sorted(errors)
    pick = lambda q: errors[min(len(errors) - 1, int(q * len(errors)))]
    return {
        "median_ms": 1000 * statistics.median(errors),
        "p90_ms": 1000 * pick(0.9),
        "p99_ms": 1000 * pick(0.99),
        "max_ms": 1000 * errors[-1],
        "within": {f"{t}s": sum(e <= t for e in errors) / len(errors) for t in TOLERANCES},
    }


def boundary_stats(ref, hyp):
    """ref, hyp: aligned lists of (start, end). Start/end errors reported separately."""
    start_err = [abs(r[0] - h[0]) for r, h in zip(ref, hyp)]
    end_err = [abs(r[1] - h[1]) for r, h in zip(ref, hyp)]
    return {
        "n": len(ref),
        "aas_ms": aas_ms(ref, hyp),
        "aas_ms_per_boundary": aas_ms(ref, hyp) / 2,
        "start": spread(start_err),
        "end": spread(end_err),
    }


def main():
    ap = argparse.ArgumentParser()
    for name in ("ctm", "session", "fragments", "sentences", "words", "time-sentences", "time-words", "out"):
        ap.add_argument(f"--{name}", required=True)
    a = ap.parse_args()

    ref = read_ctm(a.ctm, a.session)
    frags = json.load(open(a.fragments))
    sentences = json.load(open(a.sentences))
    words_run = json.load(open(a.words))
    audio_seconds = words_run["audioSeconds"]
    # 10 ms unit check (see module docstring).
    last_end = max(w[2] for w in ref)
    assert last_end <= audio_seconds + 1.0, f"ctm runs past the audio: {last_end} > {audio_seconds}"
    # Score only the span the worker was given: the sentences sent, and the
    # reference words that start inside the trimmed audio.
    first, start, end = words_run["firstSentence"], words_run["trimStart"], words_run["trimEnd"]
    frags = {
        "sentences": frags["sentences"][first:],
        "words": [{**w, "sentence": w["sentence"] - first} for w in frags["words"] if w["sentence"] >= first],
    }
    ref = [w for w in ref if start <= w[1] < end]

    text_words = [(norm(w["text"]), w["sentence"]) for w in frags["words"]]
    text_words = [w for w in text_words if w[0]]
    hyp_norm = [w[0] for w in text_words]
    ref_norm = [w[0] for w in ref]

    out = {
        "session": a.session,
        "audioSeconds": audio_seconds,
        "trim": {"startSeconds": start, "endSeconds": end, "firstSentence": first},
        "ctmLastEndSeconds": last_end,
        "referenceWords": len(ref),
        "textWords": len(hyp_norm),
        "textSentences": len(frags["sentences"]),
        "run": {
            "sentences": {**parse_time(a.time_sentences), "workerElapsedSeconds": sentences["elapsedSeconds"],
                          "workerPeakMemoryMB": sentences["peakMemoryMB"], "intervals": len(sentences["intervals"])},
            "words": {**parse_time(a.time_words), "workerElapsedSeconds": words_run["elapsedSeconds"],
                      "workerPeakMemoryMB": words_run["peakMemoryMB"], "intervals": len(words_run["intervals"])},
        },
    }
    out["excerptCheck"] = {
        level: (run.get("quality") or {}).get("match") and {k: v for k, v in run["quality"]["match"].items() if k != "text"}
        for level, run in (("sentences", sentences), ("words", words_run))
    }

    # Word error: corpus word list (reference) vs the known text (hypothesis).
    out["wordError"] = lcs_error_counts(ref_norm, hyp_norm)

    # Pair words by LCS, then compare times on the pairs.
    matches, pairs = lcs_alignment(ref_norm, hyp_norm)
    out["matchedWords"] = matches
    out["matchedFractionOfReference"] = matches / len(ref)
    out["matchedFractionOfText"] = matches / len(hyp_norm)

    if len(words_run["intervals"]) == len(frags["words"]):
        # word fragments with an empty normal form were dropped from text_words only
        keep = [i for i, w in enumerate(frags["words"]) if norm(w["text"])]
        hyp_times = [(words_run["intervals"][i]["start"], words_run["intervals"][i]["end"]) for i in keep]
        ref_t = [(ref[i][1], ref[i][2]) for i, _ in pairs]
        hyp_t = [hyp_times[j] for _, j in pairs]
        out["wordAlignment"] = boundary_stats(ref_t, hyp_t)
        worst = sorted(range(len(pairs)), key=lambda k: -(abs(ref_t[k][0] - hyp_t[k][0]) + abs(ref_t[k][1] - hyp_t[k][1])))[:10]
        out["wordAlignment"]["largestErrors"] = [
            {"word": ref[pairs[k][0]][0], "ref": ref_t[k], "hyp": hyp_t[k]} for k in worst
        ]
    else:
        out["wordAlignment"] = {"error": f"{len(words_run['intervals'])} intervals for {len(frags['words'])} fragments"}

    # Sentences: each text sentence gets the matched reference words; unmatched
    # reference words attach to the preceding sentence.
    n_sent = len(frags["sentences"])
    ref_sentence = [None] * len(ref)
    for i, j in pairs:
        ref_sentence[i] = text_words[j][1]
    last = 0
    for i in range(len(ref)):
        if ref_sentence[i] is None:
            ref_sentence[i] = last
        else:
            last = ref_sentence[i]
    ref_strings = [" ".join(ref_norm[i] for i in range(len(ref)) if ref_sentence[i] == k) for k in range(n_sent)]
    hyp_strings = [" ".join(w[0] for w in text_words if w[1] == k) for k in range(n_sent)]
    out["sentenceError"] = lcs_error_counts([s for s in ref_strings if s], [s for s in hyp_strings if s])

    if len(sentences["intervals"]) == n_sent:
        matched_by_sentence = {}
        for i, j in pairs:
            matched_by_sentence.setdefault(text_words[j][1], []).append(i)
        ref_s, hyp_s, used = [], [], []
        for k, idx in sorted(matched_by_sentence.items()):
            ref_s.append((ref[idx[0]][1], ref[idx[-1]][2]))
            hyp_s.append((sentences["intervals"][k]["start"], sentences["intervals"][k]["end"]))
            used.append(k)
        out["sentenceAlignment"] = boundary_stats(ref_s, hyp_s)
        out["sentenceAlignment"]["sentencesWithMatchedWords"] = len(used)
    else:
        out["sentenceAlignment"] = {"error": f"{len(sentences['intervals'])} intervals for {n_sent} sentences"}

    json.dump(out, open(a.out, "w"), indent=2)
    print(json.dumps({k: out[k] for k in ("wordError", "matchedFractionOfReference")}))
    for level in ("wordAlignment", "sentenceAlignment"):
        r = out[level]
        print(level, r.get("n"), r.get("aas_ms"), r.get("error"))


main()
