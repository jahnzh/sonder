"""Conservative, local compatibility checks for forced CTC paths."""
from bisect import bisect_left, bisect_right
from difflib import SequenceMatcher
import math

from ctc_acoustic import SAMPLE_RATE
from ctc_candidates import greedy_words, words


def _matched(left, right):
    return sum(block.size for block in SequenceMatcher(None, left, right, autojunk=False).get_matching_blocks())


def accepted_intervals(path, boundaries, intervals, fragments, labels, sample_offset):
    """Keep only locally supported intervals; raw forced paths are not evidence.

    All comparisons are confined to short adjacent sentence groups. A group
    needs non-blank acoustic structure, plausible timing, agreement with the
    unconstrained hypothesis, and contrast with neighboring reference groups.
    Each sentence also needs some local lexical support.
    """
    if not intervals or not boundaries:
        return []
    spoken = greedy_words(path, labels, boundaries, sample_offset)
    spoken_times = [item[1] for item in spoken]
    frame_times = [(sample_offset + boundary) / SAMPLE_RATE for boundary in boundaries]

    def observed(start, end):
        first = bisect_left(spoken_times, start - 0.25)
        last = bisect_right(spoken_times, end + 0.25)
        return [item[0] for item in spoken[first:last]]

    tokens = [words(fragment) for fragment in fragments]
    groups = [intervals[first:first + 8] for first in range(0, len(intervals), 8)]
    targets = [[word for item in group for word in tokens[item["index"]]] for group in groups]
    accepted = []
    for group_index, group in enumerate(groups):
        start, end = group[0]["start"], group[-1]["end"]
        target = targets[group_index]
        heard = observed(start, end)
        if not target or not heard or not math.isfinite(start) or not math.isfinite(end) or end <= start:
            continue
        lo, hi = bisect_left(frame_times, start), bisect_right(frame_times, end)
        frames = path[lo:hi]
        if not frames or sum(int(token) != 0 for token in frames) / len(frames) < 0.005:
            continue
        rate = len(target) / (end - start)
        if not 0.2 <= rate <= 8:
            continue
        matched = _matched(target, heard)
        coverage = matched / len(target)
        precision = matched / len(heard)
        agreement = 2 * matched / (len(target) + len(heard))
        if coverage < 0.38 or precision < 0.35 or agreement < 0.45:
            continue
        alternatives = []
        for other in (group_index - 1, group_index + 1):
            if 0 <= other < len(groups) and targets[other]:
                common = _matched(targets[other], heard)
                alternatives.append(2 * common / (len(targets[other]) + len(heard)))
        if alternatives and max(alternatives) > agreement + 0.1:
            continue
        for item in group:
            reference = tokens[item["index"]]
            if not reference or item["end"] <= item["start"]:
                continue
            local = observed(item["start"], item["end"])
            if not local:
                continue
            matcher = SequenceMatcher(None, reference, local, autojunk=False)
            blocks = [block for block in matcher.get_matching_blocks() if block.size]
            matched_words = [word for block in blocks for word in reference[block.a:block.a + block.size]]
            needed = max(1 if len(reference) < 4 else 2, math.ceil(len(reference) * 0.3))
            lexical_support = len(matched_words) >= needed and any(len(word) >= 4 for word in matched_words)
            # Greedy CTC can merge word boundaries or misspell a word while
            # preserving the spoken letters; compare those letters as well.
            expected_letters, heard_letters = "".join(reference), "".join(local)
            letter_support = (len(expected_letters) >= 8 and
                              SequenceMatcher(None, expected_letters, heard_letters, autojunk=False).ratio() >= 0.75)
            if lexical_support or letter_support:
                accepted.append(item)
    return accepted
