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
* Seam fix: a group's audio runs SEAM_OVERLAP_S past the next group's start; the last MARGIN_S of a
  non-final group and the first MARGIN_S of a non-first group are dropped before merging (the same rule
  that keeps a window's uncommitted tail), so a sentence cut by a group end is taken from the neighbour.

Everything here is numpy (and numba when it is installed); torch is not needed.
"""
import bisect
import re
import time
import unicodedata

import numpy as np

RATE = 16000
STRIDE = 320
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
# v2 ran with 30 s of overlap; the seam fix needs the overlap to outlast the trimmed margins (2 x 20 s).
SEAM_OVERLAP_S = 60
LOCATE_SECONDS = 120
LOCATE_CLUSTER = 20
SLACK_BEFORE = 10
SLACK_AFTER = 60
GAP_FILL_MAX_S = 60
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

    def locate(self, lo, seconds=LOCATE_SECONDS, cluster=LOCATE_CLUSTER):
        """First sentence of the densest cluster of 4-gram hits for the greedy words of [lo, lo+seconds)."""
        hi = min(self.em.shape[0], lo + int(seconds * RATE / STRIDE))
        heard = set(_ngrams(self.greedy_words(lo, hi)))
        hits = self.grams.hits(heard)
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
    """Earlier groups win where groups overlap; a sentence whose start contradicts its predecessor's is dropped."""
    merged = {}
    for result in outputs:
        for key, value in result.items():
            merged.setdefault(int(key), tuple(value))
    keys = sorted(merged)
    dropped = 0
    for previous, key in zip(keys, keys[1:]):
        if key in merged and previous in merged and merged[key][0] < merged[previous][0]:
            del merged[key]
            dropped += 1
    return merged, dropped


def frame_boundary(frame):
    """Sample position of a frame's start boundary on its track's grid (ctc_acoustic.frame_boundary)."""
    return frame * STRIDE + 40


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


def pool_init(emissions_path, classes, labels, sentences, kernel=None):
    """Initializer of a group-alignment process: memory-map the book's emissions once."""
    emissions = np.memmap(emissions_path, dtype=np.float16, mode="r").reshape(-1, classes)
    _SHARED["longform"] = LongForm(emissions, labels, sentences, kernel)


def pool_align(task):
    return align_group(_SHARED["longform"], task)
