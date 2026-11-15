"""Unsynced passages and extra-audio flags of a whole-book result (#403), in the shapes the server stores.

* `unsynced_passages` is `server/alignment-passages.ts` `unsyncedPassages`: every maximal run of unmapped
  sentences within a section, as `UnsyncedPassage` (`src/reading-types.ts`).
* `flags` gives `AlignmentFlag`s (`src/reading-types.ts`; the server keeps them in `anchoring.flags`), with
  the rules of `server/alignment-anchors.ts` `planSegments` and `mismatch` applied to the finished map
  instead of to anchors: narration that starts or ends more than EDGE_S inside a track (`intro`, `outro`,
  `extra-audio`), audio between two mapped sentences much longer (`extra-audio`) or much shorter
  (`skipped-text`) than the unmapped text between them, and sections with text and no mapped sentence
  (`unmatched-text`, as `server/alignment.ts` adds after an anchored run). A track with no mapped
  sentence at all is one `extra-audio` flag over the whole track (`intro` before the first narrated
  track, `outro` after the last). `first` and `last` are sentence indexes in the request's order (the
  server's fragment numbers); `start` and `end` are seconds in the track's own time.

Standard library only.
"""

# server/alignment-anchors.ts: SLACK, and `mismatch`'s ratios.
SLACK_S = 45
SKIPPED_RATIO = 0.75
EXTRA_RATIO = 1.3
# planSegments: narration starting or ending more than this inside a track is flagged.
EDGE_S = 20
# server/alignment.ts: a section with at least this many words and no mapped sentence is `unmatched-text`.
UNMATCHED_WORDS = 40
# server/alignment-passages.ts: `paragraph.text.slice(0, 120)`, in UTF-16 code units.
EXCERPT_UNITS = 120
# Words per second when the map gives no measure of its own (no two consecutive sentences mapped).
DEFAULT_RATE = 2.5
# Consecutive sentences further apart than this do not count towards the speaking rate.
RATE_STEP_MAX_S = 30


def word_count(text):
    """server/alignment-anchors.ts `wordCount`: `text.split(/\\s+/).filter(Boolean).length`."""
    return len(text.split())


def excerpt(text, units=EXCERPT_UNITS):
    """JavaScript's `text.slice(0, units)`: code points outside the BMP count as two units. A pair the cut
    would split is left out (JavaScript keeps half a pair, which JSON cannot carry)."""
    out, used = [], 0
    for char in text:
        width = 2 if ord(char) > 0xFFFF else 1
        if used + width > units:
            break
        out.append(char)
        used += width
    return "".join(out)


def sections_in_order(sentences):
    """[(section, [sentence indexes])] in reading order, a section's sentences together as the server's
    `book.sections[].paragraphs`."""
    order, members = [], {}
    for k, sentence in enumerate(sentences):
        section = sentence.get("section", 0)
        if section not in members:
            members[section] = []
            order.append(section)
        members[section].append(k)
    return [(section, members[section]) for section in order]


def section_titles(request_sections):
    return {s["index"]: s.get("title") or "" for s in (request_sections or [])}


def unsynced_passages(sentences, mapped_ids, titles):
    passages = []
    for section, members in sections_in_order(sentences):
        current = None
        for k in members:
            sentence = sentences[k]
            if sentence["id"] in mapped_ids:
                current = None
                continue
            if current is not None:
                current["lastParagraphId"] = sentence["id"]
                current["sentenceCount"] += 1
            else:
                current = {"section": section, "title": titles.get(section, ""),
                           "firstParagraphId": sentence["id"], "lastParagraphId": sentence["id"],
                           "sentenceCount": 1, "excerpt": excerpt(sentence["text"])}
                passages.append(current)
    return passages


def mismatch(seconds, expected):
    """server/alignment-anchors.ts `mismatch`: narration much shorter (skipped text) or longer (extra
    audio) than the text between two points, beyond normal pacing differences."""
    if expected > 0 and seconds / expected < SKIPPED_RATIO and expected - seconds > SLACK_S:
        return "skipped-text"
    if (expected <= 0 or seconds / expected > EXTRA_RATIO) and seconds - expected > SLACK_S:
        return "extra-audio"
    return None


def speaking_rate(rows, words):
    """Words per second over consecutive mapped sentences (k, k + 1) on one track, pauses included."""
    total_words = total_seconds = 0.0
    for a, b in zip(rows, rows[1:]):
        step = b["start"] - a["start"]
        if b["k"] == a["k"] + 1 and b["trackId"] == a["trackId"] and 0 < step <= RATE_STEP_MAX_S:
            total_words += words[a["k"]]
            total_seconds += step
    return total_words / total_seconds if total_seconds > 0 and total_words > 0 else DEFAULT_RATE


def flags(sentences, intervals, tracks, titles=None):
    """`intervals` in the server's shape (track time); `tracks` [{id, seconds}] in play order, where
    `seconds` is the track's length on the timeline the intervals use."""
    titles = titles or {}
    index = {s["id"]: k for k, s in enumerate(sentences)}
    words = [word_count(s["text"]) for s in sentences]
    rows = sorted(({"k": index[i["paragraphId"]], "trackId": i["trackId"], "start": i["start"], "end": i["end"]}
                   for i in intervals if i["paragraphId"] in index),
                  key=lambda r: (r["trackId"], r["start"], r["k"]))
    mapped = {r["k"] for r in rows}
    by_track = {}
    for row in rows:
        by_track.setdefault(row["trackId"], []).append(row)
    narrated = [n for n, t in enumerate(tracks) if by_track.get(t["id"])]
    by_reading = sorted(rows, key=lambda r: (r["k"], r["start"]))
    rate = speaking_rate(by_reading, words)
    prefix = [0]
    for k, count in enumerate(words):
        prefix.append(prefix[-1] + (0 if k in mapped else count))
    out = []
    for n, track in enumerate(tracks):
        own = by_track.get(track["id"], [])
        seconds = float(track["seconds"])
        if not own:
            if not narrated or seconds <= EDGE_S:
                continue
            kind = "intro" if n < narrated[0] else "outro" if n > narrated[-1] else "extra-audio"
            out.append({"kind": kind, "trackId": track["id"], "start": 0, "end": round(seconds, 4)})
            continue
        first_narrated, last_narrated = n == narrated[0], n == narrated[-1]
        if own[0]["start"] > EDGE_S:
            out.append({"kind": "intro" if first_narrated else "extra-audio", "trackId": track["id"],
                        "start": 0, "end": round(own[0]["start"], 4)})
        for a, b in zip(own, own[1:]):
            gap = b["start"] - a["end"]
            between = (a["k"] + 1, b["k"] - 1)  # the text between them, when the map runs forward here
            unmapped_words = prefix[b["k"]] - prefix[a["k"] + 1] if b["k"] > a["k"] + 1 else 0
            kind = mismatch(gap, unmapped_words / rate)
            if kind is None:
                continue
            flag = {"kind": kind, "trackId": track["id"], "start": round(a["end"], 4), "end": round(b["start"], 4)}
            unmapped = [k for k in range(between[0], between[1] + 1) if k not in mapped] if unmapped_words else []
            if unmapped:
                flag.update(section=sentences[unmapped[0]].get("section", 0), first=unmapped[0], last=unmapped[-1])
            out.append(flag)
        if seconds - own[-1]["end"] > EDGE_S:
            out.append({"kind": "outro" if last_narrated else "extra-audio", "trackId": track["id"],
                        "start": round(own[-1]["end"], 4), "end": round(seconds, 4)})
    if narrated:
        for section, members in sections_in_order(sentences):
            if not any(k in mapped for k in members) and sum(words[k] for k in members) >= UNMATCHED_WORDS:
                out.append({"kind": "unmatched-text", "section": section})
    for flag in out:  # server/alignment.ts: every flag with a section gets the section's title
        if "section" in flag and flag["section"] in titles:
            flag["title"] = titles[flag["section"]]
    return out
