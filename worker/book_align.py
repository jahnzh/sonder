"""Whole-book long-form CTC alignment on the global anchor chain (#402, ADR 0016).

Built from the #389 prototype (`scripts/arch-proto/longform.py` on `jahnzh/ctc-arch-more-books-2`, the
`--groups chain` variant measured in PROTO-D-E-BOOKS.md). The book's emissions are one array of frames
(the tracks' per-track emissions in track order); the text is the book's sentence list.

* A window Viterbi over `J_0 -> sentence_0 -> J_1 -> ... -> J_K`: sentences in the standard CTC topology,
  junctions that absorb audio not in the text at `delta` per frame, skip arcs that drop text not in the
  audio at `skip` per sentence, and a free end in any junction.
* The anchor chain: the text is located every SPACING_S of audio over the whole text, the longest chain of
  locations rising in audio and text is kept, slow links are dropped and the rest thinned to group starts.
* Groups are aligned independently (in a process pool) and a recovery jump stays inside its group's text.
* Seam fix: a group's audio runs SEAM_OVERLAP_S (150 s) past the next group's start, beyond the point
  where the next group's text begins; the last MARGIN_S of a non-final group and the first MARGIN_S of a
  non-first group are dropped before merging (the rule that keeps a window's uncommitted tail), so a
  sentence cut by a group end is taken from the neighbour.

Everything here is numpy (and numba when it is installed); torch is not needed.
"""
import bisect
import re
import time
import unicodedata

import numpy as np

RATE = 16000
STRIDE = 320
# The encoder frame grid both book models share (ctc_acoustic.STRIDE and RECEPTIVE_FIELD, ctc_sewd.frame_grid).
RECEPTIVE_FIELD = 400
NEG = -1e30
# The prototype's tuned alignment parameters (PROTO-D-E.md "Tuning"): unchanged.
DELTA = 1.5
SKIP = 8.0
WINDOW_S = 60
MARGIN_S = 20
TEXT_FACTOR = 1.3
MIN_TEXT_TOKENS = 400
RELOCATE_SLACK = 30
RELOCATE_HORIZON = 4000
# The v2 anchor chain's four constants (PROTO-D-E-BOOKS.md, Method 3), set once before the v2 run.
SPACING_S = 240
MIN_GROUP_S = 600
RATE_FLOOR = 0.25
LOCATE_SECONDS = 120
LOCATE_CLUSTER = 20
SLACK_BEFORE = 10
SLACK_AFTER = 60
GAP_FILL_MAX_S = 60
# Seam fix. A group's text starts SLACK_BEFORE sentences before its located sentence, which is heard
# somewhere in the LOCATE_SECONDS after the group's first frame. The previous group must therefore keep
# everything up to that point: its audio runs past the cut by the locate window plus the trimmed margin
# (v2 ran 30 s past, and lost the sentences between the cut + 30 s and the next group's first sentence).
SEAM_OVERLAP_S = LOCATE_SECONDS + MARGIN_S + 10
VALIDATION_REGION_S = 600


def tokenize(text, index):
    text = unicodedata.normalize("NFKD", text.replace("’", "'")).encode("ascii", "ignore").decode()
    ids = []
    for word in re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)*", text):
        if ids:
            ids.append(index["|"])
        ids.extend(index[c] for c in word.upper())
    return ids


# ---------------------------------------------------------------- Viterbi

def _viterbi_numpy(em, tok, first, last, blank, sep, delta, skip, force_end=False):
    """The window Viterbi in numpy, vectorised over states. Same graph, transitions and tie rules as the
    numba kernel below (a strict improvement is needed to change a backpointer)."""
    W = em.shape[0]
    N = tok.shape[0]
    K = first.shape[0]
    owner = np.zeros(N, np.int64)
    for k in range(K):
        owner[first[k]:last[k]] = k
    positions = np.arange(N)
    is_first = (first[owner] == positions) if N else np.zeros(0, bool)
    prev_diff = np.zeros(N, bool)
    if N > 1:
        prev_diff[1:] = (tok[:-1] != tok[1:]) & ~is_first[1:]
    nonempty = last > first
    end_token = np.where(nonempty, last - 1, 0)
    has_end = np.zeros(K + 1, bool)
    has_end[1:] = nonempty
    end_index = np.zeros(K + 1, np.int64)
    end_index[1:] = end_token
    cumulative = np.zeros(K + 1, np.float64)
    cumulative[1:] = np.cumsum(np.asarray(skip, np.float64))
    em64 = np.asarray(em, np.float64)
    js_all = np.maximum(np.maximum(em64[:, blank], em64[:, sep]), em64.max(axis=1) - delta)
    T = np.full(N, NEG)
    B = np.full(N, NEG)
    J = np.full(K + 1, NEG)
    bpT = np.zeros((W, N), np.uint8)
    bpB = np.zeros((W, N), np.uint8)
    bpJ = np.zeros((W, K + 1), np.uint8)
    neg_n = np.full(N, NEG)
    neg_k = np.full(K + 1, NEG)
    for t in range(W):
        e = em64[t]
        js = js_all[t]
        if t == 0:
            s = np.full(N, NEG)
            b = np.zeros(N, np.uint8)
            if K and nonempty[0]:
                s[first[0]] = 0.0
                b[first[0]] = 1
        else:
            s = T.copy()
            previous_blank = np.empty(N)
            previous_token = np.empty(N)
            if N:
                previous_blank[0] = NEG
                previous_blank[1:] = B[:-1]
                previous_token[0] = NEG
                previous_token[1:] = T[:-1]
            entry = np.where(is_first, J[owner] if N else neg_n, previous_blank)
            better = entry > s
            s = np.where(better, entry, s)
            b = better.astype(np.uint8)
            repeat = np.where(prev_diff, previous_token, neg_n)
            better = repeat > s
            s = np.where(better, repeat, s)
            b = np.where(better, np.uint8(2), b)
        T2 = s + (e[tok] if N else 0.0)
        bpT[t] = b
        better = T > B
        B2 = np.where(better, T, B) + e[blank]
        bpB[t] = better
        if t == 0:
            s = neg_k.copy()
            s[0] = 0.0
            b = np.zeros(K + 1, np.uint8)
        else:
            s = J.copy()
            end_t = np.where(has_end, T[end_index] if N else neg_k, neg_k)
            end_b = np.where(has_end, B[end_index] if N else neg_k, neg_k)
            better = end_t > s
            s = np.where(better, end_t, s)
            b = better.astype(np.uint8)
            better = end_b > s
            s = np.where(better, end_b, s)
            b = np.where(better, np.uint8(2), b)
        s = s + js
        # Skip arcs within one frame: J2[k] = max(s[k], J2[k-1] - skip[k-1]), as a running maximum.
        shifted = s + cumulative
        running = np.maximum.accumulate(shifted)
        skipped = running > shifted
        J2 = np.where(skipped, running - cumulative, s)
        bpJ[t] = np.where(skipped, np.uint8(3), b)
        T, B, J = T2, B2, J2
    end = int(np.argmax(J)) if K + 1 else 0
    if force_end:
        end = K
    starts, ends = _backtrace(bpT, bpB, bpJ, first, last, owner, end, W, K)
    return end, starts, ends


def _backtrace(bpT, bpB, bpJ, first, last, owner, end, W, K):
    starts = np.full(K, -1, np.int64)
    ends = np.full(K, -1, np.int64)
    kind = 2  # 0 token, 1 blank, 2 junction
    index = end
    t = W - 1
    while t >= 0:
        if kind == 2:
            b = bpJ[t, index]
            if b == 3:
                index -= 1
                continue
            if b == 1 or b == 2:
                kind = 0 if b == 1 else 1
                index = int(last[index - 1]) - 1
            t -= 1
            continue
        if kind == 1:
            if bpB[t, index] == 1:
                kind = 0
            t -= 1
            continue
        k = owner[index]
        if ends[k] < 0:
            ends[k] = t + 1
        starts[k] = t
        b = bpT[t, index]
        if b == 1:
            if index == first[k]:
                kind = 2
                index = k
            else:
                kind = 1
                index -= 1
        elif b == 2:
            index -= 1
        t -= 1
    return starts, ends


try:  # numba is optional: the same kernel compiled, about 20 times faster than the numpy fallback.
    from numba import njit
except ImportError:  # pragma: no cover - depends on the host
    njit = None

if njit is not None:
    @njit(cache=False)
    def _viterbi_numba(em, tok, first, last, blank, sep, delta, skip, force_end=False):
        W = em.shape[0]
        N = tok.shape[0]
        K = first.shape[0]
        owner = np.zeros(N, np.int64)
        for k in range(K):
            for j in range(first[k], last[k]):
                owner[j] = k
        T = np.full(N, NEG, np.float64)
        B = np.full(N, NEG, np.float64)
        J = np.full(K + 1, NEG, np.float64)
        T2 = np.empty(N, np.float64)
        B2 = np.empty(N, np.float64)
        J2 = np.empty(K + 1, np.float64)
        bpT = np.zeros((W, N), np.uint8)
        bpB = np.zeros((W, N), np.uint8)
        bpJ = np.zeros((W, K + 1), np.uint8)
        for t in range(W):
            e = em[t]
            best = e[0]
            for v in range(1, e.shape[0]):
                if e[v] > best:
                    best = e[v]
            js = np.float64(e[blank])
            if e[sep] > js:
                js = np.float64(e[sep])
            if best - delta > js:
                js = best - delta
            for j in range(N):
                k = owner[j]
                y = tok[j]
                s = T[j]
                b = 0
                if j == first[k]:
                    c = J[k]
                    if c > s:
                        s = c
                        b = 1
                else:
                    c = B[j - 1]
                    if c > s:
                        s = c
                        b = 1
                    if tok[j - 1] != y:
                        c = T[j - 1]
                        if c > s:
                            s = c
                            b = 2
                if t == 0:
                    s = NEG
                    if j == first[k] and k == 0:
                        s = 0.0
                        b = 1
                T2[j] = s + e[y]
                bpT[t, j] = b
                s = B[j]
                b = 0
                if T[j] > s:
                    s = T[j]
                    b = 1
                B2[j] = s + e[blank]
                bpB[t, j] = b
            for k in range(K + 1):
                s = J[k]
                b = 0
                if k > 0 and last[k - 1] > first[k - 1]:
                    j = last[k - 1] - 1
                    if T[j] > s:
                        s = T[j]
                        b = 1
                    if B[j] > s:
                        s = B[j]
                        b = 2
                if t == 0:
                    s = 0.0 if k == 0 else NEG
                    b = 0
                s = s + js
                if k > 0:
                    c = J2[k - 1] - skip[k - 1]
                    if c > s:
                        s = c
                        b = 3
                J2[k] = s
                bpJ[t, k] = b
            for j in range(N):
                T[j] = T2[j]
                B[j] = B2[j]
            for k in range(K + 1):
                J[k] = J2[k]
        end = 0
        for k in range(K + 1):
            if J[k] > J[end]:
                end = k
        if force_end:
            end = K
        starts = np.full(K, -1, np.int64)
        ends = np.full(K, -1, np.int64)
        kind = 2
        index = end
        t = W - 1
        while t >= 0:
            if kind == 2:
                b = bpJ[t, index]
                if b == 3:
                    index -= 1
                    continue
                if b == 1 or b == 2:
                    j = last[index - 1] - 1
                    kind = 0 if b == 1 else 1
                    index = j
                t -= 1
                continue
            if kind == 1:
                b = bpB[t, index]
                if b == 1:
                    kind = 0
                t -= 1
                continue
            k = owner[index]
            if ends[k] < 0:
                ends[k] = t + 1
            starts[k] = t
            b = bpT[t, index]
            if b == 1:
                if index == first[k]:
                    kind = 2
                    index = k
                else:
                    kind = 1
                    index -= 1
            elif b == 2:
                index -= 1
            t -= 1
        return end, starts, ends


def viterbi(em, tok, first, last, blank, sep, delta, skip, force_end=False, kernel=None):
    """(best final junction, start frame per sentence, end frame per sentence; -1 = skipped)."""
    kernel = kernel or ("numba" if njit is not None else "numpy")
    em = np.ascontiguousarray(em, dtype=np.float32)
    tok = np.ascontiguousarray(tok, dtype=np.int32)
    first = np.ascontiguousarray(first, dtype=np.int64)
    last = np.ascontiguousarray(last, dtype=np.int64)
    skip = np.ascontiguousarray(skip, dtype=np.float64)
    if kernel == "numba":
        if njit is None:
            raise RuntimeError("numba is not installed")
        end, starts, ends = _viterbi_numba(em, tok, first, last, blank, sep, float(delta), skip, bool(force_end))
        return int(end), starts, ends
    return _viterbi_numpy(em, tok, first, last, blank, sep, float(delta), skip, force_end)


def kernel_name():
    return "numba" if njit is not None else "numpy"


# ---------------------------------------------------------------- text lookup

def text_words(text):
    from ctc_candidates import words
    return words(text)


def _ngrams(words_list, n=4):
    return [tuple(words_list[i:i + n]) for i in range(len(words_list) - n + 1)]


class GramIndex:
    """Word 4-gram -> sentence occurrences, so a lookup counts hits without scanning every sentence.

    hits[k] is the number of 4-gram occurrences of sentence k that were heard, as the prototype's
    `sum(g in heard for g in grams[k])`.
    """

    def __init__(self, sentences):
        self.count = len(sentences)
        self.index = {}
        for k, text in enumerate(sentences):
            for gram in _ngrams(text_words(text)):
                self.index.setdefault(gram, []).append(k)

    def hits(self, heard, lo=0, hi=None):
        hi = self.count if hi is None else hi
        out = np.zeros(max(0, hi - lo), np.float64)
        for gram in heard:
            for k in self.index.get(gram, ()):
                if lo <= k < hi:
                    out[k - lo] += 1
        return out


# ---------------------------------------------------------------- long-form pass

class LongForm:
    def __init__(self, emissions, labels, sentences, kernel=None):
        self.em = emissions
        self.labels = list(labels)
        self.index = {label: i for i, label in enumerate(self.labels)}
        self.blank, self.sep = self.index["-"], self.index["|"]
        self.sentences = sentences
        self.tokens = [np.array(tokenize(text, self.index), np.int32) for text in sentences]
        self.W = int(WINDOW_S * RATE / STRIDE)
        self.margin = int(MARGIN_S * RATE / STRIDE)
        self.kernel = kernel
        self.grams = GramIndex(sentences)
        self.stats = new_stats()

    def locate(self, lo, seconds=LOCATE_SECONDS, cluster=LOCATE_CLUSTER, allowed=None, hi=None):
        """First sentence of the densest cluster of 4-gram hits for the greedy words of [lo, lo+seconds)
        (or [lo, hi)). `allowed` (a boolean array over the sentences) limits the hits to those sentences."""
        hi = min(self.em.shape[0], lo + int(seconds * RATE / STRIDE) if hi is None else hi)
        heard = set(_ngrams(self.greedy_words(lo, hi)))
        hits = self.grams.hits(heard)
        if allowed is not None:
            hits = np.where(allowed, hits, 0.0)
        if hits.sum() < 5:
            return None
        window = np.convolve(hits, np.ones(cluster), mode="full")[cluster - 1:]
        best = int(window.argmax())
        if window[best] < 5:
            return None
        return best + int(np.flatnonzero(hits[best:best + cluster])[0])

    def _text_window(self, cursor, frames, rate, bonus=0):
        budget = max(MIN_TEXT_TOKENS, int(frames * rate * TEXT_FACTOR)) + bonus
        end, count = cursor, 0
        while end < len(self.tokens) and count < budget:
            count += len(self.tokens[end]) + 1
            end += 1
        return end

    def greedy_words(self, lo, hi):
        path = np.asarray(self.em[lo:hi]).argmax(axis=1)
        out, prev, letters = [], -1, []
        for token in path:
            token = int(token)
            if token != prev and token != self.blank:
                label = self.labels[token]
                if label == "|":
                    if letters:
                        out.append("".join(letters))
                        letters = []
                else:
                    letters.append(label)
            prev = token
        if letters:
            out.append("".join(letters))
        return out

    def _relocate(self, cursor, lo, hi, horizon):
        """The single sentence with the most 4-gram hits (at least 3) in [cursor, cursor + horizon)."""
        heard = set(_ngrams(self.greedy_words(lo, hi)))
        if len(heard) < 5:
            return None
        end = min(len(self.sentences), cursor + horizon)
        hits = self.grams.hits(heard, cursor, end)
        if not len(hits):
            return None
        best = int(hits.argmax())  # first maximum, as the prototype's strict `>` scan
        return cursor + best if hits[best] >= 3 else None

    def _graph(self, lo, hi):
        ids = np.concatenate([self.tokens[k] for k in range(lo, hi)] or [np.zeros(0, np.int32)])
        first = np.zeros(hi - lo, np.int64)
        last = np.zeros(hi - lo, np.int64)
        offset = 0
        for i, k in enumerate(range(lo, hi)):
            first[i] = offset
            offset += len(self.tokens[k])
            last[i] = offset
        return ids, first, last

    def run(self, a_start=0, a_end=None, cursor=0, stop_sentence=None, should_stop=None):
        """Align audio frames [a_start, a_end) from sentence `cursor`; recovery stays below `stop_sentence`."""
        frames_total = self.em.shape[0] if a_end is None else a_end
        stop = len(self.sentences) if stop_sentence is None else min(stop_sentence, len(self.sentences))
        a0 = a_start
        rate = 0.28  # tokens per frame (about 14 per second)
        aligned_tokens = aligned_frames = 0
        bonus = 0
        result = {}
        while a0 < frames_total - 25 and cursor < stop:
            if should_stop is not None and should_stop():
                raise Cancelled()
            hi = min(frames_total, a0 + self.W)
            final = hi == frames_total
            s1 = min(stop, self._text_window(cursor, hi - a0, rate, bonus))
            ids, first, last = self._graph(cursor, s1)
            em = np.asarray(self.em[a0:hi], dtype=np.float32)
            skips = np.where(last > first, SKIP, 0.0).astype(np.float64)
            _, starts, ends = viterbi(em, ids, first, last, self.blank, self.sep, DELTA, skips, kernel=self.kernel)
            self.stats["windows"] += 1
            limit = (hi - a0) if final else (hi - a0 - self.margin)
            committed = -1
            for i in range(len(first)):
                if starts[i] >= 0 and ends[i] <= limit:
                    committed = i
            if committed < 0 and final:
                break
            if committed < 0:
                target = self._relocate(cursor, a0, hi, min(RELOCATE_HORIZON, stop - cursor))
                if target is not None and target > cursor:
                    hit = target
                    target = max(cursor + 1, target - RELOCATE_SLACK)
                    bonus = sum(len(self.tokens[k]) + 1 for k in range(target, hit))
                    self.stats["recoveries_text"] += 1
                    cursor = target
                else:
                    self.stats["recoveries_audio"] += 1
                    a0 += max(1, (hi - a0) - self.margin)
                continue
            for i in range(committed + 1):
                if starts[i] >= 0:
                    result[cursor + i] = (a0 + int(starts[i]), a0 + int(ends[i]))
                    aligned_tokens += len(self.tokens[cursor + i]) + 1
                    aligned_frames += int(ends[i] - starts[i])
            if aligned_frames > 2000:
                rate = min(0.6, max(0.12, aligned_tokens / aligned_frames))
            a0 += int(ends[committed])
            cursor += committed + 1
            bonus = 0
        self.gap_fill(result)
        return result

    def gap_fill(self, result, max_gap_s=GAP_FILL_MAX_S):
        """Force runs of unaligned sentences into the audio between their aligned neighbours."""
        keys = sorted(result)
        filled = 0
        for left, right in zip(keys, keys[1:]):
            if right - left < 2:
                continue
            lo, hi = result[left][1], result[right][0]
            run = list(range(left + 1, right))
            tokens = sum(len(self.tokens[k]) for k in run)
            if not tokens or hi - lo < tokens * 1.2 or hi - lo > max_gap_s * RATE / STRIDE:
                continue
            ids, first, last = self._graph(left + 1, right)
            skips = np.where(last > first, 1e6, 0.0).astype(np.float64)
            em = np.asarray(self.em[lo:hi], dtype=np.float32)
            _, starts, ends = viterbi(em, ids, first, last, self.blank, self.sep, DELTA, skips, True,
                                      kernel=self.kernel)
            for i, k in enumerate(run):
                if starts[i] >= 0:
                    result[k] = (lo + int(starts[i]), lo + int(ends[i]))
                    filled += 1
        self.stats["gap_filled"] += filled


class Cancelled(Exception):
    """The job was cancelled while a group was being aligned."""


def new_stats():
    return {"windows": 0, "recoveries_text": 0, "recoveries_audio": 0, "gap_filled": 0}


# ---------------------------------------------------------------- anchor chain and groups

def longest_chain(points):
    """Longest chain of (frame, sentence) points strictly increasing in sentence (frames already increase)."""
    tails, tail_index, parent = [], [], [-1] * len(points)
    for i, (_, sentence) in enumerate(points):
        j = bisect.bisect_left(tails, sentence)
        if j == len(tails):
            tails.append(sentence)
            tail_index.append(i)
        else:
            tails[j] = sentence
            tail_index[j] = i
        parent[i] = tail_index[j - 1] if j else -1
    chain, i = [], tail_index[-1] if tail_index else -1
    while i >= 0:
        chain.append(points[i])
        i = parent[i]
    return chain[::-1]


def chain_starts(candidates, min_group_frames, rate_floor=RATE_FLOOR):
    """Group starts from located (frame, sentence) candidates: longest rising chain, slow links dropped,
    starts at least `min_group_frames` apart. Always begins with (0, 0)."""
    chain = longest_chain(candidates)
    dropped = 0
    if len(chain) > 2:
        rates = [(b[1] - a[1]) / (b[0] - a[0]) for a, b in zip(chain, chain[1:])]
        median = float(np.median(rates))
        kept = [p for p, r in zip(chain, rates) if r >= rate_floor * median] + [chain[-1]]
        dropped = len(chain) - len(kept)
        chain = kept
    starts = [(0, 0)]
    for frame, sentence in chain:
        if frame - starts[-1][0] >= min_group_frames and sentence > starts[-1][1]:
            starts.append((frame, sentence))
    return starts, {"candidates": len(candidates), "chain": len(chain) + dropped, "chainRateDropped": dropped,
                    "groups": len(starts)}


def candidate_frames(frames):
    step = int(SPACING_S * RATE / STRIDE)
    return list(range(step, max(step, frames - 3000), step))


def plan_groups(longform, should_stop=None):
    """Locate every SPACING_S, keep the chain and turn it into group tasks (the unit of progress and resume)."""
    started = time.monotonic()
    frames = longform.em.shape[0]
    candidates = []
    for frame in candidate_frames(frames):
        if should_stop is not None and should_stop():
            raise Cancelled()
        sentence = longform.locate(frame)
        if sentence is not None:
            candidates.append((frame, sentence))
    starts, info = chain_starts(candidates, int(MIN_GROUP_S * RATE / STRIDE))
    info["anchorSeconds"] = time.monotonic() - started
    return group_tasks(starts, frames), info


def group_tasks(starts, frames):
    overlap = int(SEAM_OVERLAP_S * RATE / STRIDE)
    tasks = []
    for i, (frame, sentence) in enumerate(starts):
        last = i + 1 == len(starts)
        a_end = frames if last else min(frames, starts[i + 1][0] + overlap)
        stop = None if last else starts[i + 1][1] + SLACK_AFTER
        tasks.append({"index": i, "aStart": int(frame), "aEnd": int(a_end),
                      "cursor": int(max(0, sentence - SLACK_BEFORE) if i else 0),
                      "stop": None if stop is None else int(stop),
                      "first": i == 0, "last": last})
    return tasks


def align_group(longform, task, should_stop=None):
    """Align one group and trim its seams. Returns ({sentence: (start frame, end frame)}, stats, trimmed),
    where `trimmed` holds the intervals the seam trim dropped (kept for diagnosis)."""
    longform.stats = new_stats()
    raw = longform.run(task["aStart"], task["aEnd"], task["cursor"], task["stop"], should_stop)
    kept = trim_seams(raw, task, longform.margin)
    trimmed = {k: v for k, v in raw.items() if k not in kept}
    stats = dict(longform.stats, seamTrimmed=len(trimmed))
    return kept, stats, trimmed


def trim_seams(raw, task, margin):
    """Drop what a group cut may have spoiled: sentences starting in its first `margin` frames (unless it
    is the first group) and sentences ending in its last `margin` frames (unless it is the last group)."""
    lo = task["aStart"] + (0 if task["first"] else margin)
    hi = task["aEnd"] - (0 if task["last"] else margin)
    return {k: v for k, v in raw.items() if v[0] >= lo and v[1] <= hi}


def merge_groups(outputs):
    """Earlier groups win where groups overlap; a sentence that starts before the last sentence kept ahead
    of it is dropped, so the kept starts never decrease in sentence order."""
    merged = {}
    for result in outputs:
        for key, value in result.items():
            merged.setdefault(int(key), tuple(value))
    dropped = 0
    last = None  # the start of the last sentence kept
    for key in sorted(merged):
        start = merged[key][0]
        if last is not None and start < last:
            del merged[key]
            dropped += 1
        else:
            last = start
    return merged, dropped


# ---------------------------------------------------------------- leftover pass (#403)
#
# The chain follows one rising order through audio and text, so a recording whose chapters run in another
# order than the ebook's leaves those chapters unmapped (Antimemetics: 69 % agreement with production, which
# anchors per section). The leftover pass locates unmapped audio stretches against unmapped text only and
# aligns what it finds there. It never changes the chain's map: it adds only sentences the chain did not
# map, inside audio no mapped sentence uses, and each piece it adds is validated on its own.

# An unmapped audio stretch shorter than this is a pause or a short insert, not a displaced chapter.
LEFTOVER_MIN_GAP_S = 120
# An unmapped run of fewer sentences than this is not looked for (the chain's small misses stay misses).
LEFTOVER_MIN_RUN = 20
# The located sentence is somewhere in its probe's LOCATE_SECONDS, and a piece's audio starts one probe
# before it: its text starts this many sentences earlier (or at its run's start).
LEFTOVER_SLACK_BEFORE = 60
# Rounds of locate-and-align; a later round sees the gaps and runs the earlier ones left.
LEFTOVER_ROUNDS = 3
# Located probes a piece needs before it is aligned. Measured (2026-11-15, WSL, numba): on Antimemetics two
# probes keep 1,185 of the 1,187 sentences one probe gives; on the Dorian Gray pairings, whose unmapped audio
# is chapters the ebook lacks, one-probe pieces held 1 to 8 sentences each and none of production's.
LEFTOVER_MIN_PROBES = 2


def audio_gaps(intervals, frames, min_frames):
    """[lo, hi) frame stretches of at least `min_frames` that no interval covers (head and tail included)."""
    gaps, covered = [], 0
    for start, end in sorted(intervals):
        if start - covered >= min_frames:
            gaps.append((covered, start))
        covered = max(covered, end)
    if frames - covered >= min_frames:
        gaps.append((covered, frames))
    return gaps


def text_runs(mapped, count, min_run):
    """[lo, hi) sentence ranges of at least `min_run` consecutive sentences not in `mapped`."""
    runs, start = [], None
    for k in range(count + 1):
        if k < count and k not in mapped:
            if start is None:
                start = k
            continue
        if start is not None and k - start >= min_run:
            runs.append((start, k))
        start = None
    return runs


def leftover_pieces(probes, gap, runs, probe_frames):
    """Pieces of one gap from its located probes [(frame, sentence)]: consecutive probes in the same run
    whose sentences do not run backwards form one piece, if there are LEFTOVER_MIN_PROBES of them. Returns
    tasks for LongForm.run: a piece's audio runs from one probe before its first probe to one probe past
    its last (its own probe window and one more), within the gap and at most one probe into the next
    piece; its text starts LEFTOVER_SLACK_BEFORE sentences before the first located sentence and stops at
    its run's end. Audio a piece leaves out is a gap again in the next round."""
    def run_of(sentence):
        i = bisect.bisect_right([lo for lo, _ in runs], sentence) - 1
        return runs[i] if i >= 0 and runs[i][0] <= sentence < runs[i][1] else None

    groups = []
    for frame, sentence in probes:
        run = run_of(sentence)
        if run is None:
            continue
        last = groups[-1] if groups else None
        if last is not None and last["run"] == run and sentence >= last["sentences"][-1] - LOCATE_CLUSTER:
            last["frames"].append(frame)
            last["sentences"].append(sentence)
        else:
            groups.append({"run": run, "frames": [frame], "sentences": [sentence]})
    groups = [g for g in groups if len(g["frames"]) >= LEFTOVER_MIN_PROBES]
    pieces = []
    for i, group in enumerate(groups):
        lo = max(gap[0], group["frames"][0] - probe_frames)
        hi = min(gap[1], group["frames"][-1] + 2 * probe_frames)
        if i + 1 < len(groups):
            hi = min(hi, groups[i + 1]["frames"][0] + probe_frames)
        run_lo, run_hi = group["run"]
        pieces.append({"aStart": int(lo), "aEnd": int(hi), "cursor": int(max(run_lo, group["sentences"][0] - LEFTOVER_SLACK_BEFORE)),
                       "stop": int(run_hi), "run": [int(run_lo), int(run_hi)], "probes": len(group["frames"])})
    return pieces


class Covered:
    """The audio the map so far uses, as disjoint sorted [start, end) frame spans."""

    def __init__(self, intervals=()):
        self.starts, self.ends = [], []
        for start, end in sorted(intervals):
            if self.ends and start <= self.ends[-1]:
                self.ends[-1] = max(self.ends[-1], end)
            else:
                self.starts.append(start)
                self.ends.append(end)

    def overlaps(self, start, end):
        i = bisect.bisect_right(self.starts, start) - 1
        if i >= 0 and self.ends[i] > start:
            return True
        return i + 1 < len(self.starts) and self.starts[i + 1] < end

    def add(self, start, end):
        i = bisect.bisect_right(self.starts, start) - 1
        if i >= 0 and self.ends[i] >= start:
            start, end = self.starts[i], max(end, self.ends[i])
            del self.starts[i], self.ends[i]
        else:
            i += 1
        while i < len(self.starts) and self.starts[i] <= end:
            end = max(end, self.ends[i])
            del self.starts[i], self.ends[i]
        self.starts.insert(i, start)
        self.ends.insert(i, end)


def run_piece(longform, task, should_stop=None):
    """The long-form pass over one leftover piece: {sentence: (start frame, end frame)}."""
    return longform.run(task["aStart"], task["aEnd"], task["cursor"], task["stop"], should_stop)


def leftover_pass(longform, chain, should_stop=None, rounds=LEFTOVER_ROUNDS, run_pieces=None):
    """Locate and align unmapped audio against unmapped text after the chain.

    `chain` is the chain's merged map {sentence: (start frame, end frame)}; it is not changed. Returns
    (pieces, info): each piece is a map of sentences the chain did not map, rising in audio and text,
    inside audio no sentence of the chain (or an earlier piece) covers. A piece is validated on its own.

    `run_pieces(tasks)` aligns a round's pieces and returns their raw maps in task order (the job runs
    them in its process pool); by default they run here, one after the other. A piece's alignment does
    not depend on the others, so the order of running does not change the result."""
    if run_pieces is None:
        def run_pieces(tasks):
            return [run_piece(longform, task, should_stop) for task in tasks]
    started = time.monotonic()
    frames = longform.em.shape[0]
    probe_frames = int(LOCATE_SECONDS * RATE / STRIDE)
    min_gap = int(LEFTOVER_MIN_GAP_S * RATE / STRIDE)
    taken = dict(chain)
    covered = Covered(chain.values())
    pieces = []
    info = {"rounds": 0, "gaps": 0, "gapSeconds": 0.0, "probes": 0, "located": 0, "pieces": 0, "raw": 0}
    saved = dict(longform.stats)
    for _ in range(rounds):
        gaps = audio_gaps(list(taken.values()), frames, min_gap)
        runs = text_runs(taken, len(longform.sentences), LEFTOVER_MIN_RUN)
        if not gaps or not runs:
            break
        info["rounds"] += 1
        allowed = np.zeros(len(longform.sentences), bool)
        for lo, hi in runs:
            allowed[lo:hi] = True
        added = 0
        tasks = []
        for gap in gaps:
            info["gaps"] += 1
            info["gapSeconds"] += (gap[1] - gap[0]) * STRIDE / RATE
            probes = []
            for frame in range(gap[0], gap[1] - 25, probe_frames):
                if should_stop is not None and should_stop():
                    raise Cancelled()
                info["probes"] += 1
                sentence = longform.locate(frame, allowed=allowed, hi=min(gap[1], frame + probe_frames))
                if sentence is not None:
                    probes.append((frame, sentence))
            info["located"] += len(probes)
            tasks.extend({**task, "gap": [int(gap[0]), int(gap[1])]}
                         for task in leftover_pieces(probes, gap, runs, probe_frames))
        if should_stop is not None and should_stop():
            raise Cancelled()
        for task, raw in zip(tasks, run_pieces(tasks) if tasks else []):
            gap = task["gap"]
            piece = {}
            for k in sorted(raw):
                start, end = raw[k]
                if (k in taken or not task["run"][0] <= k < task["run"][1] or start < gap[0] or end > gap[1]
                        or covered.overlaps(start, end)):
                    continue
                piece[k] = (start, end)
                taken[k] = (start, end)
                covered.add(start, end)
            if piece:
                pieces.append(piece)
                added += len(piece)
                info["raw"] += len(piece)
        if not added:
            break
    info["pieces"] = len(pieces)
    info["gapSeconds"] = round(info["gapSeconds"], 1)
    info["seconds"] = round(time.monotonic() - started, 3)
    longform.stats = saved  # the chain groups' statistics stay as they were
    return pieces, info


def frame_boundary(frame):
    """Sample position of a frame's start boundary on its track's grid (ctc_acoustic.frame_boundary): half a
    stride before the frame's centre, RECEPTIVE_FIELD / 2 + STRIDE * frame. Both book models (Wav2Vec2 Base and
    SEW-D tiny, #921) have this grid; `book_encode` refuses a model whose frame count says otherwise."""
    return frame * STRIDE + (RECEPTIVE_FIELD - STRIDE) // 2


def validate(longform, raw, to_seconds=None):
    """The worker's accepted_intervals over the merged intervals in consecutive regions of the book.

    `to_seconds(frame)` maps a global frame to book seconds (default: one continuous grid).
    """
    from ctc_validation import accepted_intervals
    to_seconds = to_seconds or (lambda frame: frame_boundary(frame) / RATE)
    keys = sorted(raw)
    accepted = {}
    region = int(VALIDATION_REGION_S * RATE / STRIDE)
    frames = longform.em.shape[0]
    i = 0
    while i < len(keys):
        lo_frame = max(0, raw[keys[i]][0] - 50)
        j = i
        while j < len(keys) and raw[keys[j]][1] - lo_frame < region:
            j += 1
        j = max(j, i + 1)
        chunk = keys[i:j]
        hi_frame = min(frames, raw[chunk[-1]][1] + 50)
        path = np.asarray(longform.em[lo_frame:hi_frame]).argmax(axis=1).tolist()
        bounds = [round(to_seconds(f) * RATE) for f in range(lo_frame, hi_frame)]
        fragments = [longform.sentences[k] for k in chunk]
        # An end frame is exclusive: the end of its last frame, on that frame's own track grid.
        intervals = [{"index": n, "start": to_seconds(raw[k][0]),
                      "end": min(to_seconds(raw[k][1] - 1) + STRIDE / RATE, (bounds[-1] + STRIDE) / RATE)}
                     for n, k in enumerate(chunk)]
        for item in accepted_intervals(path, bounds, intervals, fragments, longform.labels, 0):
            accepted[chunk[item["index"]]] = (item["start"], item["end"])
        i = j
    return accepted


# ---------------------------------------------------------------- process pool for groups

_SHARED = {}


PR_SET_PDEATHSIG = 1
PR_GET_PDEATHSIG = 2


def die_with_parent(parent):
    """Linux: SIGKILL this process when the worker that started it dies, even by SIGKILL (no orphans).

    The signal follows the thread that created the pool; the job thread shuts its pool down before it ends.
    """
    import ctypes
    import os
    import signal
    try:
        ctypes.CDLL(None, use_errno=True).prctl(PR_SET_PDEATHSIG, int(signal.SIGKILL), 0, 0, 0)
    except (OSError, AttributeError):
        return
    if parent is not None and os.getppid() != parent:
        os._exit(1)  # the worker died before the signal was armed


def death_signal():
    """The armed parent-death signal of this process (0 when none); for tests."""
    import ctypes
    value = ctypes.c_int(0)
    ctypes.CDLL(None, use_errno=True).prctl(PR_GET_PDEATHSIG, ctypes.byref(value), 0, 0, 0)
    return value.value


def pool_init(emissions_path, classes, labels, sentences, kernel=None, parent=None):
    """Initializer of a group-alignment process: die with the worker, memory-map the book's emissions once."""
    die_with_parent(parent)
    emissions = np.memmap(emissions_path, dtype=np.float16, mode="r").reshape(-1, classes)
    _SHARED["longform"] = LongForm(emissions, labels, sentences, kernel)


def pool_align(task):
    return align_group(_SHARED["longform"], task)


def pool_piece(task):
    return run_piece(_SHARED["longform"], task)
