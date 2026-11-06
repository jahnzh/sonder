import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSeriesDefaults, type SeriesCandidate } from "../src/series-selection.ts";

const candidate = (id: number, position: number | null, extra: Partial<SeriesCandidate> = {}): SeriesCandidate => ({
  id, position, unreleased: false, ...extra,
});

test("series defaults rank linked works, language, popularity, release and id", () => {
  const works = [
    candidate(1, 1, { language: "en", popularity: 200 }),
    candidate(2, 1, { language: "fr", workId: "linked", popularity: 1 }),
    candidate(3, 2, { language: "fr", popularity: 100 }),
    candidate(4, 2, { language: "en", popularity: 10 }),
    candidate(5, 3, { popularity: 1 }),
    candidate(6, 3, { popularity: 2 }),
    candidate(7, 4, { popularity: 2, releaseDate: "2020-01-01" }),
    candidate(8, 4, { popularity: 2, releaseDate: "2019-01-01" }),
    candidate(9, 5), candidate(10, 5),
    candidate(11, null), candidate(12, 6, { unreleased: true }), candidate(13, 6, { needsAdmin: true }),
  ];
  assert.deepEqual([...selectSeriesDefaults(works, "en-US")], [2, 4, 6, 8, 9]);
});

test("series language falls back to editions only when the default edition has no language", () => {
  const works = [
    candidate(1, 1, { language: "fr", editionLanguages: ["en"], popularity: 100 }),
    candidate(2, 1, { editionLanguages: ["en"], popularity: 1 }),
    candidate(3, 2, { language: "fr", popularity: 2 }),
    candidate(4, 2, { language: "de", popularity: 3 }),
  ];
  assert.deepEqual([...selectSeriesDefaults(works, "en")], [2, 4]);
});
