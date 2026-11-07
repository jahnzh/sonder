"""The sole TorchAudio forced-alignment adapter, isolated from model lifetime."""
import os
import re
import unicodedata

from ctc_acoustic import SAMPLE_RATE, STRIDE

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


def align(emissions, boundaries, fragments, labels, sample_count, track_offset, torch):
    import torchaudio

    ids, owners = tokenize(fragments, labels)
    if not ids:
        return []
    if emissions.shape[1] * len(ids) > MAX_PATH_CELLS:
        raise ValueError("The chapter is too large for the bounded CTC path adapter.")
    target = torch.tensor([ids], dtype=torch.int32, device=emissions.device)
    with torch.inference_mode():
        path, scores = torchaudio.functional.forced_align(emissions, target, blank=0)
    spans = torchaudio.functional.merge_tokens(path[0].cpu(), scores[0].cpu(), blank=0)
    if [span.token for span in spans] != ids:
        raise ValueError("The CTC path did not cover its complete text target.")
    return intervals_for_spans(spans, owners, boundaries, sample_count, track_offset)
