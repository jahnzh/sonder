// The browser server's series on AudiobookDB (#721 part b): what the Hardcover browser fixture's series were, on
// AudiobookDB's text ids, so the series specs' addresses (`#series/701`) keep working. Added to the recorded answers
// of tests/audiobookdb-fixture.ts for the browser server only; the unit tests never see them.
//
// - "701" The Crossing by Ada North: Alice (Lewis Carroll, as the Hardcover shelves put her in the library) at 1,
//   Crossing Two at 2, Crossing Companion without a number (a related work), Future Crossing at 3 (not out yet).
//   Crossing Three at 4 is the book AudiobookDB lists later (the New mark): only once a spec asks for it through
//   `POST /api/__fixture/audiobookdb-series` (`late`), which also reads the series again as the daily refresh would.
// - "702" The Crossing by Bea South: Alice alone, the other series of the same name.
// - "703" The Ferry Road by Wren Hollis: AudiobookDB's own labels (a novella at "1.5") and, from Open Library, the
//   third book that has no audiobook yet.
// - "704" The Lantern Keeper by Iris Vale: three books whose audio searches tests/series-queue-browser-fixture.ts
//   answers (#898), for the spec of the series queue on the Series page.
// Covers are https addresses on a reserved name (`.test` never resolves), so a page shows them without a live call;
// a spec that wants them drawn routes the host.
import { seriesMember, type FixtureControl, type FixtureMember, type FixtureSeries, type OpenLibrarySeriesDoc } from "./audiobookdb-fixture.ts";

export const BROWSER_COVER_HOST = "covers.audiobookdb.test";
const person = (name: string, role: string) => ({ name, role: { name: role } });

/** A member with an English language and a cover; `label` null for a work the series lists without a number. */
function member(id: string, title: string, author: string, label: string | null, sortKey: number | null, extra: Record<string, unknown> = {}): FixtureMember {
  const entry = seriesMember(id, title, author, label ?? "", sortKey ?? 0, { narrator: "Kara Shallenberg", releaseDate: "2020-01-01", ...extra });
  entry.book.cover = { url: `https://${BROWSER_COVER_HOST}/${id}.jpg` };
  return (label === null ? { ...entry, position: null } : entry) as FixtureMember;
}

const ALICE = "Alice’s Adventures in Wonderland";
const crossingBooks = (): FixtureMember[] => [
  member("501", ALICE, "Lewis Carroll", "1", 1),
  member("503", "Crossing Two", "Ada North", "2", 2),
  member("504", "Crossing Companion", "Ada North", null, null),
  member("505", "Future Crossing", "Ada North", "3", 3, { releaseDate: "2999-01-01" }),
];
const LATE = () => member("506", "Crossing Three", "Ada North", "4", 4);

export const browserSeries = (): FixtureSeries[] => [
  { id: "701", name: "The Crossing", people: [person("Ada North", "Author")], bookCount: 4, books: crossingBooks() },
  { id: "702", name: "The Crossing", people: [person("Bea South", "Author")], bookCount: 1, books: [member("501", ALICE, "Lewis Carroll", "1", 1)] },
  {
    id: "703",
    name: "The Ferry Road",
    people: [person("Wren Hollis", "Author")],
    bookCount: 3,
    books: [
      member("711", "The Ferry Road", "Wren Hollis", "1", 1),
      member("712", "A Night at the Landing", "Wren Hollis", "1.5", 1.5, { runtimeLengthMs: 5_400_000 }),
      member("713", "Low Water", "Wren Hollis", "2", 2),
    ],
  },
  {
    id: "704",
    name: "The Lantern Keeper",
    people: [person("Iris Vale", "Author")],
    bookCount: 3,
    books: [
      member("721", "The Lantern Keeper", "Iris Vale", "1", 1),
      member("722", "Keeper of Tides", "Iris Vale", "2", 2),
      member("723", "The Last Light", "Iris Vale", "3", 3),
    ],
  },
];
/** Open Library's answer to `series:"The Ferry Road"`: the first book (AudiobookDB has it) and the third (it has not). */
const FERRY_ROAD_OPEN_LIBRARY: OpenLibrarySeriesDoc[] = [
  { key: "/works/OL9100001W", title: "The Ferry Road", author_name: ["Wren Hollis"], first_publish_year: 2019, language: ["eng"], series_name: ["The Ferry Road"], series_position: ["1"] },
  { key: "/works/OL9100003W", title: "The Far Bank", author_name: ["Wren Hollis"], first_publish_year: 2024, language: ["eng"], series_name: ["The Ferry Road"], series_position: ["3"] },
];

/** Adds the browser server's series to the recorded answers. */
export function installBrowserSeries(control: FixtureControl) {
  for (const series of browserSeries()) control.series.set(series.id, series);
  control.openLibrarySeries.set("the ferry road", FERRY_ROAD_OPEN_LIBRARY);
}

/** Whether AudiobookDB lists Crossing Three in "701" (the book it listed later). */
export function listLateCrossing(control: FixtureControl, late: boolean) {
  const crossing = control.series.get("701")!;
  crossing.books = late ? [...crossingBooks(), LATE()] : crossingBooks();
  crossing.bookCount = late ? 5 : 4;
}
