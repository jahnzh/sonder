"""Read Montreal Forced Aligner TextGrids from the LibriSpeech alignment archive.

Only the standard library is used. The archive is read in place with zipfile and
is never extracted or executed.

Usage:
  python3 -I scripts/alignment-replication/mfa_textgrid.py \
      artifacts/6/librispeech-mfa/librispeech_alignments.zip artifacts/6/librispeech-mfa/words.jsonl
"""

import json
import re
import sys
import zipfile

INTERVAL_RE = re.compile(r'^\s*intervals \[\d+\]:\s*$')
TIER_RE = re.compile(r'^\s*item \[\d+\]:\s*$')
NAME_RE = re.compile(r'^\s*name = "(.*)"\s*$')
XMIN_RE = re.compile(r'^\s*xmin = ([0-9.eE+-]+)\s*$')
XMAX_RE = re.compile(r'^\s*xmax = ([0-9.eE+-]+)\s*$')
TEXT_RE = re.compile(r'^\s*text = "(.*)"\s*$')


def parse_words_tier(text):
    """Return [(label, xmin, xmax), ...] for the tier named "words".

    MFA writes silences as empty labels. They are kept, so the sequence still
    covers the whole utterance.
    """
    lines = text.splitlines()
    in_words = False
    in_tier = False
    intervals = []
    cur = None
    for line in lines:
        if TIER_RE.match(line):
            in_tier = True
            in_words = False
            cur = None
            continue
        if not in_tier:
            continue
        m = NAME_RE.match(line)
        if m and cur is None:
            in_words = m.group(1) == "words"
            continue
        if not in_words:
            continue
        if INTERVAL_RE.match(line):
            if cur is not None:
                intervals.append(cur)
            cur = {}
            continue
        if cur is None:
            continue
        m = XMIN_RE.match(line)
        if m:
            cur["xmin"] = float(m.group(1))
            continue
        m = XMAX_RE.match(line)
        if m:
            cur["xmax"] = float(m.group(1))
            continue
        m = TEXT_RE.match(line)
        if m:
            cur["text"] = m.group(1).replace('""', '"')
    if cur is not None:
        intervals.append(cur)
    return [(iv["text"], iv["xmin"], iv["xmax"]) for iv in intervals if "text" in iv]


def utterance_id_from_member(name):
    # e.g. test-clean/1089/134686/1089-134686-0000.TextGrid
    parts = name.split("/")
    split, speaker, chapter = parts[0], parts[1], parts[2]
    utt = parts[3][: -len(".TextGrid")]
    return split, speaker, chapter, utt


def iter_textgrids(zip_path):
    with zipfile.ZipFile(zip_path) as z:
        for member in z.namelist():
            if member.endswith(".TextGrid"):
                yield member, z.read(member).decode("utf-8")


def main(zip_path, out_path):
    counts = {}
    n_words = 0
    with open(out_path, "w", encoding="utf-8") as out:
        for member, text in iter_textgrids(zip_path):
            split, speaker, chapter, utt = utterance_id_from_member(member)
            intervals = parse_words_tier(text)
            counts[split] = counts.get(split, 0) + 1
            n_words += sum(1 for label, _, _ in intervals if label)
            row = {
                "utt": utt,
                "split": split,
                "speaker": speaker,
                "chapter": chapter,
                "intervals": [[label, xmin, xmax] for label, xmin, xmax in intervals],
            }
            out.write(json.dumps(row, separators=(",", ":")) + "\n")
    summary = {"textgrids_per_split": counts, "labelled_word_intervals": n_words}
    print(json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: mfa_textgrid.py <librispeech_alignments.zip> <out.jsonl>")
    main(sys.argv[1], sys.argv[2])
