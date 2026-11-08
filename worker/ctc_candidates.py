"""Locate short acoustic hypotheses in supplied text without a second model."""
import re
import unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher

from ctc_acoustic import SAMPLE_RATE


def words(text):
    text = unicodedata.normalize("NFKD", text.replace("’", "'"))
    text = text.encode("ascii", "ignore").decode().upper()
    return re.findall(r"[A-Z]+(?:'[A-Z]+)*", text)


def greedy_words(path, labels, boundaries, sample_offset):
    """Collapse a CTC best path and retain each word's source-grid start."""
    result = []
    letters = []
    first = None
    previous = None

    def finish():
        nonlocal first
        if letters:
            result.append(("".join(letters), (sample_offset + first) / SAMPLE_RATE))
            letters.clear()
        first = None

    for token, boundary in zip(path, boundaries):
        token = int(token)
        if token != previous and token != 0:
            label = labels[token]
            if label == "|":
                finish()
            elif re.fullmatch(r"[A-Z']", label):
                if first is None:
                    first = max(0, boundary)
                letters.append(label)
        previous = token
    finish()
    return result


def _search_passages(spoken, fragment_tokens, limit=8):
    """Search a pre-tokenised fragment list; identical results to building it each call."""
    query = [word for word, _ in spoken]
    if not 6 <= len(query) <= 256:
        return []
    candidates = {}
    corpus, owners = [], []

    def search_scope():
        index = defaultdict(list)
        for pos in range(len(corpus) - 2):
            index[tuple(corpus[pos:pos + 3])].append(pos)
        votes = Counter()
        for pos in range(len(query) - 2):
            for occurrence in index.get(tuple(query[pos:pos + 3]), []):
                votes[max(0, occurrence - pos)] += 1
        for estimate, _ in votes.most_common(512):
            for start in range(max(0, estimate - 2), min(len(corpus), estimate + 3)):
                end = min(len(corpus), start + len(query))
                matcher = SequenceMatcher(None, query, corpus[start:end], autojunk=False)
                score = matcher.ratio()
                if score < 0.5:
                    continue
                blocks = [block for block in matcher.get_matching_blocks() if block.size]
                if not blocks:
                    continue
                block = blocks[0]
                owner = owners[start + block.b]
                final = blocks[-1]
                candidate = {"index": owner, "lastIndex": owners[start + final.b + final.size - 1],
                             "score": round(score, 3), "start": spoken[block.a][1]}
                if owner not in candidates or candidate["score"] > candidates[owner]["score"]:
                    candidates[owner] = candidate
        # Keep the intermediate result bounded even for a book of repetitions.
        if len(candidates) > max(64, limit * 8):
            keep = sorted(candidates.values(), key=lambda item: (-item["score"], item["index"]))[:max(64, limit * 8)]
            candidates.clear()
            candidates.update((item["index"], item) for item in keep)

    # Carry enough text across each boundary for a whole query and its seed.
    overlap = len(query) + 4
    for owner, tokens in fragment_tokens:
        for token in tokens:
            corpus.append(token)
            owners.append(owner)
            if len(corpus) == 8192:
                search_scope()
                del corpus[:-overlap]
                del owners[:-overlap]
    if corpus:
        search_scope()
    return sorted(candidates.values(), key=lambda candidate: (-candidate["score"], candidate["index"]))[:limit]


class FragmentIndex:
    """Tokenise fragments once and reuse them for many locate calls in one request."""

    def __init__(self, fragments):
        self.fragment_tokens = [(owner, words(fragment)) for owner, fragment in enumerate(fragments)]

    def candidate_passages(self, spoken, limit=8):
        return _search_passages(spoken, self.fragment_tokens, limit)


def candidate_passages(spoken, fragments, limit=8):
    """Return distinct, high-scoring text locations, including repeated passages.

    Trigram votes limit the number of local comparisons; neither a book-wide
    dynamic-programming matrix nor a path over a whole recording is allocated.
    """
    return FragmentIndex(fragments).candidate_passages(spoken, limit)


def locate_from_path(path, boundaries, labels, sample_offset, fragment_tokens=None, fragments=None, limit=8):
    """CPU-only locate from a collapsed CTC path (picklable for a process pool)."""
    spoken = greedy_words(path, labels, boundaries, sample_offset)
    if fragment_tokens is not None:
        matches = _search_passages(spoken, fragment_tokens, limit)
    else:
        matches = FragmentIndex(fragments).candidate_passages(spoken, limit)
    return {"text": " ".join(word for word, _ in spoken), "matches": matches,
            "match": matches[0] if matches else None,
            "start": matches[0]["start"] if matches else sample_offset / SAMPLE_RATE}


def locate(emissions, boundaries, fragments, labels, sample_offset, index=None):
    path = emissions.argmax(dim=-1)[0].detach().cpu().tolist()
    fragment_tokens = index.fragment_tokens if index is not None else None
    return locate_from_path(path, boundaries, labels, sample_offset,
                            fragment_tokens=fragment_tokens, fragments=fragments)


# Per-process FragmentIndex for ProcessPoolExecutor workers (built once in the initializer).
_POOL_TOKENS = None


def _pool_init(fragment_tokens):
    global _POOL_TOKENS
    _POOL_TOKENS = fragment_tokens


def _pool_locate(job):
    path, boundaries, labels, sample_offset = job
    return locate_from_path(path, boundaries, labels, sample_offset, fragment_tokens=_POOL_TOKENS)
