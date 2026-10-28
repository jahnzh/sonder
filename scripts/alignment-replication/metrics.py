"""Metric definitions used in the replication, written as the papers state them.

AAS: Swan Forced Aligner, Eq. (14) in SwanVoice (arXiv:2605.30993), following
     Shi et al. 2022 [41]. Per word slot the error is |start error| + |end error|,
     averaged over the N evaluated word slots. Output is milliseconds.

LCS word/sentence error: Braunschweiler et al. 2010, Sec. 2. The two word (or
     sentence) lists are aligned by longest common subsequence. The paper does not
     say how the unmatched items are classed, so this module uses the usual
     convention: inside each gap between matched items, the first min(n_ref, n_hyp)
     pairs are substitutions and the rest are deletions (ref only) or insertions
     (hyp only). Err = (S + D + I) / N_ref, which matches the way Table 2.1 sums
     its columns.

Not implemented: the "bad onset / bad offset" boundary check in Braunschweiler
     et al. 2010, Sec. 4. The paper does not give a tolerance in ms or a labelling
     protocol, so there is no definition to code.
"""


def aas_ms(reference, hypothesis):
    """Accumulated averaging shift in milliseconds.

    reference, hypothesis: equal-length lists of (start_s, end_s) per word slot.
    """
    if len(reference) != len(hypothesis):
        raise ValueError("reference and hypothesis must have the same number of word slots")
    if not reference:
        raise ValueError("no word slots")
    total = 0.0
    for (rs, re_), (hs, he) in zip(reference, hypothesis):
        total += abs(rs - hs) + abs(re_ - he)
    return 1000.0 * total / len(reference)


def lcs_alignment(ref, hyp):
    """Return (matches, pairs) for the longest common subsequence of two lists.

    pairs is a list of (ref_index, hyp_index) for matched items, in order.
    """
    n, m = len(ref), len(hyp)
    table = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            if ref[i] == hyp[j]:
                table[i][j] = table[i + 1][j + 1] + 1
            else:
                table[i][j] = max(table[i + 1][j], table[i][j + 1])
    pairs = []
    i = j = 0
    while i < n and j < m:
        if ref[i] == hyp[j]:
            pairs.append((i, j))
            i += 1
            j += 1
        elif table[i + 1][j] >= table[i][j + 1]:
            i += 1
        else:
            j += 1
    return len(pairs), pairs


def lcs_error_counts(ref, hyp):
    """Substitutions, deletions, insertions and error rate from an LCS alignment."""
    _, pairs = lcs_alignment(ref, hyp)
    sub = dele = ins = 0
    # Walk the gaps between matched pairs, with a sentinel at each end.
    anchors = pairs + [(len(ref), len(hyp))]
    prev_i, prev_j = 0, 0
    for mi, mj in anchors:
        gap_ref = mi - prev_i
        gap_hyp = mj - prev_j
        paired = min(gap_ref, gap_hyp)
        sub += paired
        dele += gap_ref - paired
        ins += gap_hyp - paired
        prev_i, prev_j = mi + 1, mj + 1
    n_ref = len(ref)
    if n_ref == 0:
        raise ValueError("empty reference")
    return {
        "sub": sub,
        "del": dele,
        "ins": ins,
        "n_ref": n_ref,
        "err": (sub + dele + ins) / n_ref,
    }
