"""Unsynced passages and flags of a whole-book result (#403) in the shapes the server stores.

The samples below are copied from the production database (read-only, 2026-11-15): `alignment_jobs.data`
`anchoring.flags` and `unsyncedPassages`. Standard library only, so this runs everywhere.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import book_report

# recording-torbox-129969003 (The Left Hand of Darkness), anchored map: its first flags, verbatim.
PRODUCTION_LHOD_FLAGS = [
    {"kind": "intro", "trackId": "torbox-129969003-1", "start": 0, "end": 704.8455469266357},
    {"kind": "outro", "trackId": "torbox-129969003-1", "start": 35239.44604923993, "end": 36458.949319},
    {"kind": "unmatched-text", "section": 1, "title": "Section 2"},
    {"kind": "unmatched-text", "section": 2, "title": "Table of Contents"},
    {"kind": "unmatched-text", "section": 26, "title": "The Gethenian Calendar and Clock"},
]
# recording-torbox-128609707 (Dungeon Crawler Carl), its first unsynced passage, verbatim (the excerpt is the
# whole of a title line).
PRODUCTION_PASSAGE = {"section": 1, "title": "Dungeon Crawler Carl", "firstParagraphId": "1:0",
                      "lastParagraphId": "1:2", "sentenceCount": 3, "excerpt": "Dungeon Crawler Carl"}
# Every key set each flag kind has in production (all 31 jobs), so a worker flag is one the server already holds.
PRODUCTION_FLAG_SHAPES = {
    "intro": [{"kind", "trackId", "start", "end"}],
    "outro": [{"kind", "trackId", "start", "end"}],
    "unmatched-text": [{"kind", "section", "title"}],
    "extra-audio": [{"kind", "trackId", "start", "end"},
                    {"kind", "trackId", "start", "end", "section", "first", "last"},
                    {"kind", "trackId", "start", "end", "section", "first", "last", "title"}],
    "skipped-text": [{"kind", "trackId", "start", "end", "section", "first", "last"},
                     {"kind", "trackId", "start", "end", "section", "first", "last", "title"}],
}
TYPES = {"kind": str, "trackId": str, "start": (int, float), "end": (int, float), "section": int, "first": int,
         "last": int, "title": str}


def words(n, seed=0):
    return " ".join(f"w{seed}x{i}" for i in range(n)) + "."


def interval(sentence, track, start, end):
    return {"paragraphId": sentence["id"], "section": sentence["section"], "trackId": track, "start": start,
            "end": end, "confidence": 0.65}


class Passages(unittest.TestCase):
    def test_a_run_of_unmapped_sentences_is_the_production_passage(self):
        sentences = [{"id": "1:0", "section": 1, "text": "Dungeon Crawler Carl"},
                     {"id": "1:1", "section": 1, "text": words(5, 1)},
                     {"id": "1:2", "section": 1, "text": words(5, 2)},
                     {"id": "2:0", "section": 2, "text": words(9, 3)}]
        passages = book_report.unsynced_passages(sentences, {"2:0"}, {1: "Dungeon Crawler Carl", 2: "Chapter 1"})
        self.assertEqual(passages, [PRODUCTION_PASSAGE])
        self.assertEqual(list(passages[0]), list(PRODUCTION_PASSAGE))  # the same key order too

    def test_runs_end_at_mapped_sentences_and_at_section_ends(self):
        sentences = [{"id": f"{s}:{k}", "section": s, "text": words(4, s * 10 + k)} for s in (3, 4) for k in range(4)]
        passages = book_report.unsynced_passages(sentences, {"3:1", "4:2"}, {})
        self.assertEqual([(p["firstParagraphId"], p["lastParagraphId"], p["sentenceCount"]) for p in passages],
                         [("3:0", "3:0", 1), ("3:2", "3:3", 2), ("4:0", "4:1", 2), ("4:3", "4:3", 1)])
        self.assertEqual({p["title"] for p in passages}, {""})  # no titles in the request

    def test_excerpt_is_javascripts_slice_of_120_utf16_units(self):
        self.assertEqual(book_report.excerpt("a" * 130), "a" * 120)
        self.assertEqual(book_report.excerpt("😀" * 61), "😀" * 60)  # two units each
        self.assertEqual(book_report.excerpt("a" + "😀" * 60), "a" + "😀" * 59)  # a split pair is left out


class Flags(unittest.TestCase):
    def lhod_like(self):
        """One 36,458.95 s track narrated from 704.85 s to 35,239.45 s; sections 1, 2 and 26 have text and
        nothing mapped, section 3 is mapped throughout."""
        sentences = ([{"id": f"1:{k}", "section": 1, "text": words(10, k)} for k in range(5)]
                     + [{"id": f"2:{k}", "section": 2, "text": words(10, 10 + k)} for k in range(5)]
                     + [{"id": f"3:{k}", "section": 3, "text": words(12, 20 + k)} for k in range(1000)]
                     + [{"id": f"26:{k}", "section": 26, "text": words(10, 30 + k)} for k in range(5)])
        start, end = 704.8455469266357, 35239.44604923993
        step = (end - start) / 1000
        intervals = [interval(sentences[10 + k], "torbox-129969003-1", start + k * step, start + (k + 1) * step - 0.3)
                     for k in range(1000)]
        intervals[-1]["end"] = end
        titles = {1: "Section 2", 2: "Table of Contents", 3: "Chapter 1", 26: "The Gethenian Calendar and Clock"}
        return sentences, intervals, titles

    def test_a_map_like_left_hand_gives_the_production_flags(self):
        sentences, intervals, titles = self.lhod_like()
        flags = book_report.flags(sentences, intervals, [{"id": "torbox-129969003-1", "seconds": 36458.949319}], titles)
        self.assertEqual([{k: v for k, v in f.items() if k not in ("start", "end")} for f in flags],
                         [{k: v for k, v in f.items() if k not in ("start", "end")} for f in PRODUCTION_LHOD_FLAGS])
        for mine, production in zip(flags, PRODUCTION_LHOD_FLAGS):
            self.assertEqual(list(mine), list(production))
            for key in ("start", "end"):
                if key in production:
                    self.assertAlmostEqual(mine[key], production[key], places=3)

    def assert_production_shape(self, flags):
        for flag in flags:
            self.assertIn(set(flag), PRODUCTION_FLAG_SHAPES[flag["kind"]], flag)
            for key, value in flag.items():
                self.assertIsInstance(value, TYPES[key], (key, flag))

    def test_extra_audio_skipped_text_and_whole_tracks(self):
        # Track a: s0..s9 every 5 s, then 120 s of audio with no text between s9 and s10 (extra audio), then
        # s10..s19; s20..s39 (200 words, about 80 s at the map's rate) are not mapped and s40 follows s19 after 4 s
        # (skipped text). Track b is not narrated at all; track c holds s41..s49 from 30 s (extra audio at its head).
        sentences = [{"id": f"p{k}", "section": 0 if k < 20 else 1 if k < 41 else 2, "text": words(10, k)}
                     for k in range(50)]
        intervals, t = [], 0.0
        for k in range(20):
            if k == 10:
                t += 120.0
            intervals.append(interval(sentences[k], "a", t, t + 4.5))
            t += 5.0
        intervals.append(interval(sentences[40], "a", t + 4.0, t + 8.5))
        for n, k in enumerate(range(41, 50)):
            intervals.append(interval(sentences[k], "c", 30.0 + 5 * n, 34.5 + 5 * n))
        tracks = [{"id": "a", "seconds": t + 9.0}, {"id": "b", "seconds": 600.0}, {"id": "c", "seconds": 76.0}]
        flags = book_report.flags(sentences, intervals, tracks, {1: "Part Two"})
        self.assert_production_shape(flags)
        self.assertEqual([f["kind"] for f in flags], ["extra-audio", "skipped-text", "extra-audio", "extra-audio"])
        extra, skipped, track_b, head_c = flags
        self.assertEqual(extra, {"kind": "extra-audio", "trackId": "a", "start": 49.5, "end": 170.0})
        self.assertEqual(skipped, {"kind": "skipped-text", "trackId": "a", "start": round(t - 0.5, 4),
                                   "end": t + 4.0, "section": 1, "first": 20, "last": 39, "title": "Part Two"})
        self.assertEqual(track_b, {"kind": "extra-audio", "trackId": "b", "start": 0, "end": 600.0})
        self.assertEqual(head_c, {"kind": "extra-audio", "trackId": "c", "start": 0, "end": 30.0})

    def test_unnarrated_tracks_before_and_after_the_narration_are_intro_and_outro(self):
        sentences = [{"id": f"p{k}", "section": 0, "text": words(10, k)} for k in range(10)]
        intervals = [interval(sentences[k], "b", 5.0 * k, 5.0 * k + 4.5) for k in range(10)]
        tracks = [{"id": "a", "seconds": 300.0}, {"id": "b", "seconds": 50.0}, {"id": "c", "seconds": 30.0}]
        flags = book_report.flags(sentences, intervals, tracks, {})
        self.assertEqual([(f["kind"], f["trackId"]) for f in flags], [("intro", "a"), ("outro", "c")])
        self.assert_production_shape(flags)

    def test_a_chapter_out_of_order_flags_no_text_between_its_neighbours(self):
        # The leftover pass maps s20..s29 between s9 and s10 in time: the gaps around it are short, nothing flagged.
        sentences = [{"id": f"p{k}", "section": 0 if k < 20 else 1, "text": words(10, k)} for k in range(30)]
        order = list(range(10)) + list(range(20, 30)) + list(range(10, 20))
        intervals = [interval(sentences[k], "a", 5.0 * n, 5.0 * n + 4.5) for n, k in enumerate(order)]
        self.assertEqual(book_report.flags(sentences, intervals, [{"id": "a", "seconds": 150.0}], {}), [])

    def test_short_sections_and_empty_maps_are_not_flagged(self):
        sentences = [{"id": "a", "section": 0, "text": words(39)}, {"id": "b", "section": 1, "text": words(10, 1)}]
        tracks = [{"id": "t", "seconds": 100.0}]
        self.assertEqual(book_report.flags(sentences, [interval({"id": "b", "section": 1}, "t", 0.0, 4.0)], tracks), [
            {"kind": "outro", "trackId": "t", "start": 4.0, "end": 100.0}])
        self.assertEqual(book_report.flags(sentences, [], tracks), [])

    def test_mismatch_is_the_servers_rule(self):
        # server/alignment-anchors.ts mismatch(seconds, expected) with SLACK = 45
        self.assertEqual(book_report.mismatch(100, 200), "skipped-text")
        self.assertIsNone(book_report.mismatch(160, 200))  # 0.8: within pacing
        self.assertIsNone(book_report.mismatch(10, 50))  # shorter, but by less than the slack
        self.assertEqual(book_report.mismatch(300, 200), "extra-audio")
        self.assertIsNone(book_report.mismatch(60, 20))  # 3x, but only 40 s more
        self.assertEqual(book_report.mismatch(46, 0), "extra-audio")
        self.assertIsNone(book_report.mismatch(44, 0))


if __name__ == "__main__":
    unittest.main()
