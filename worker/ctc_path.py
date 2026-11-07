"""The sole TorchAudio forced-alignment adapter, isolated from model lifetime."""
import os
import re
import unicodedata

from ctc_acoustic import SAMPLE_RATE, STRIDE
from ctc_validation import accepted_intervals

# Bound the native path matrix before allocating it. Larger scopes need the
# bounded passage planner from a later slice, not an unbounded GPU allocation.
# A host with more GPU memory can raise the bound with ALIGNMENT_CTC_MAX_PATH_CELLS.
def _max_path_cells(env=os.environ):
    try:
        value = int(env.get("ALIGNMENT_CTC_MAX_PATH_CELLS", ""))
    except ValueError:
        return 500_000_000
    return value if 1_000_000 <= value <= 20_000_000_000 else 500_000_000


MAX_PATH_CELLS = _max_path_cells()


def tokenize(fragments, labels):
    dictionary = {label: index for index, label in enumerate(labels)}
    ids, owners = [], []
    for owner, text in enumerate(fragments):
        text = unicodedata.normalize("NFKD", text.replace("’", "'")).encode("ascii", "ignore").decode()
        for word in re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)*", text):
            if ids:
                ids.append(dictionary["|"])
                owners.append(None)
            for char in word.upper():
                ids.append(dictionary[char])
                owners.append(owner)
    return ids, owners


def intervals_for_spans(spans, owners, boundaries, sample_count, track_offset):
    grouped = {}
    for span, owner in zip(spans, owners):
        if owner is not None:
            grouped.setdefault(owner, []).append(span)
    intervals = []
    for owner, group in grouped.items():
        start = max(0, boundaries[group[0].start])
        last = group[-1].end
        end = boundaries[last] if last < len(boundaries) else boundaries[-1] + STRIDE
        end = min(sample_count, end)
        if end > start:
            intervals.append({"index": owner, "start": (track_offset + start) / SAMPLE_RATE,
                              "end": (track_offset + end) / SAMPLE_RATE})
    return intervals


def bounded_scopes(frame_count, fragments, labels, max_cells):
    """Split by text and proportional audio, with bounded overlapping audio edges."""
    counts = [len(tokenize([fragment], labels)[0]) + 1 for fragment in fragments]
    prefix = [0]
    for count in counts:
        prefix.append(prefix[-1] + count)
    scopes = []

    def split(first, last, lo, hi):
        size = prefix[last] - prefix[first]
        if (hi - lo) * size <= max_cells:
            scopes.append((first, last, lo, hi))
            return
        if last - first < 2 or hi - lo < 2:
            # No safe boundary inside one sentence; leave it unsynced.
            return
        midpoint = (prefix[first] + prefix[last]) / 2
        middle = min(range(first + 1, last), key=lambda index: abs(prefix[index] - midpoint))
        cut = lo + round((hi - lo) * (prefix[middle] - prefix[first]) / size)
        cut = max(lo + 1, min(hi - 1, cut))
        overlap = min(500, (hi - lo) // 10)
        split(first, middle, lo, min(hi, cut + overlap))
        split(middle, last, max(lo, cut - overlap), hi)

    if fragments and frame_count:
        split(0, len(fragments), 0, frame_count)
    return scopes


def _align_scope(emissions, boundaries, fragments, labels, sample_count, track_offset, torch):
    import torchaudio

    ids, owners = tokenize(fragments, labels)
    repeats = sum(a == b for a, b in zip(ids, ids[1:]))
    if not ids or len(ids) + repeats > emissions.shape[1]:
        return []
    target = torch.tensor([ids], dtype=torch.int32, device=emissions.device)
    with torch.inference_mode():
        path, scores = torchaudio.functional.forced_align(emissions, target, blank=0)
    spans = torchaudio.functional.merge_tokens(path[0].cpu(), scores[0].cpu(), blank=0)
    if [span.token for span in spans] != ids:
        raise ValueError("The CTC path did not cover its complete text target.")
    intervals = intervals_for_spans(spans, owners, boundaries, sample_count, track_offset)
    greedy = emissions.argmax(dim=-1)[0].detach().cpu().tolist()
    return accepted_intervals(greedy, boundaries, intervals, fragments, labels, track_offset)


def align(emissions, boundaries, fragments, labels, sample_count, track_offset, torch):
    result = []
    for first, last, lo, hi in bounded_scopes(emissions.shape[1], fragments, labels, MAX_PATH_CELLS):
        for item in _align_scope(emissions[:, lo:hi], boundaries[lo:hi], fragments[first:last],
                                 labels, sample_count, track_offset, torch):
            result.append({**item, "index": item["index"] + first})
    return result
