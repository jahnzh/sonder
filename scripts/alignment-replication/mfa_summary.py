"""Descriptive statistics for the LibriSpeech MFA word alignments.

These are properties of the machine-made reference. They are not accuracy figures:
the MFA output is the pseudo-label that SwanVoice trains on, not human timing.

Usage:
  python3 -I scripts/alignment-replication/mfa_summary.py \
      artifacts/6/librispeech-mfa/words.jsonl artifacts/6/mfa_summary.json
"""

import json
import sys


def quantile(sorted_values, q):
    if not sorted_values:
        return None
    return sorted_values[min(len(sorted_values) - 1, int(q * len(sorted_values)))]


def main(words_path, out_path):
    per_split = {}
    lead, trail, word_dur = [], [], []
    bad_order = 0
    n_utt = n_words = 0
    with open(words_path, encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            ivs = row["intervals"]
            words = [(s, e) for label, s, e in ivs if label]
            if not words:
                continue
            n_utt += 1
            n_words += len(words)
            per_split[row["split"]] = per_split.get(row["split"], 0) + 1
            lead.append(words[0][0])
            trail.append(ivs[-1][2] - words[-1][1])
            prev_end = 0.0
            for s, e in words:
                if e < s or s < prev_end - 1e-6:
                    bad_order += 1
                word_dur.append(e - s)
                prev_end = e
    lead.sort()
    trail.sort()
    word_dur.sort()
    summary = {
        "utterances_with_words": n_utt,
        "utterances_per_split": per_split,
        "word_intervals": n_words,
        "non_monotonic_word_intervals": bad_order,
        "leading_silence_s": {q: quantile(lead, q) for q in (0.5, 0.9, 0.99)},
        "trailing_silence_s": {q: quantile(trail, q) for q in (0.5, 0.9, 0.99)},
        "word_duration_s": {q: quantile(word_dur, q) for q in (0.01, 0.5, 0.99)},
    }
    with open(out_path, "w", encoding="utf-8") as out:
        json.dump(summary, out, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: mfa_summary.py <words.jsonl> <out.json>")
    main(sys.argv[1], sys.argv[2])
