// Test-only AudiobookDB, Open Library, Google Books and iTunes answers (#721). No live call is made in a test: the AudiobookDB answers
// follow the fields the ticket recorded from the docs and anonymous calls on 18 Nov (search wrapped per type, a
// book's releases, a release's people with roles, external ids, chapterDetail); the Open Library ones follow its
// documented search.json and works/{id}.json; the Google Books ones its documented volume resource (a key-less call
// from the build host on 19 Nov got only the 429 recorded below); the iTunes ones are trimmed from a live search and
// lookup of 19 Nov. Never bundled into the production server.

export type FixtureCall = { url: string; method: string; headers: Record<string, string>; body: unknown };
export type FixtureControl = {
  calls: FixtureCall[];
  /** The next AudiobookDB answers: a status (with headers) instead of the recorded one. */
  failNext: { status: number; headers?: Record<string, string>; body?: string }[];
  /** Every AudiobookDB request fails at the network. */
  offline: boolean;
  /** The RateLimit-Remaining the next answers carry. */
  remaining: number;
  /** Ids AudiobookDB, Google Books or iTunes no longer has. */
  gone: Set<string>;
  /** Series AudiobookDB lists (`GET /series/{id}`, `POST /search` type series), by id; a test may add or change one. */
  series: Map<string, FixtureSeries>;
  /** Open Library's answer to `series:"<name>"`, by the lower-case name. */
  openLibrarySeries: Map<string, OpenLibrarySeriesDoc[]>;
  /** The next Google Books / iTunes answers: a status (with headers and body) instead of the recorded one. */
  failGoogle: { status: number; headers?: Record<string, string>; body?: string }[];
  failItunes: { status: number; headers?: Record<string, string>; body?: string }[];
};
export type FixtureMember = { position: { label: string; sortKey: number }; book: Record<string, unknown> };
export type FixtureSeries = { id: string; name: string; people?: { name: string; role: { name: string } }[]; bookCount?: number; books: FixtureMember[] };
export type OpenLibrarySeriesDoc = { key: string; title: string; author_name: string[]; first_publish_year?: number; cover_i?: number; language?: string[]; series_name?: string[]; series_position?: string[] };

const person = (name: string, role: string) => ({ name, role: { name: role } });
const release = (id: string, bookId: string, narrator: string, ms: number, language: string, asin: string | null, chapters: number) => ({
  id,
  book: { id: bookId },
  title: null,
  people: [person(narrator, "Narrator")],
  duration: Math.round(ms / 1000),
  runtimeLengthMs: ms,
  isbn: "9781000000001",
  publisher: { name: "Recorded Books" },
  language: { code: language === "English" ? "en" : "de", name: language },
  disambiguation: "Unabridged",
  external: asin ? [{ source: "audible", id: asin }] : [],
  chapterDetail: { chapters: Array.from({ length: chapters }, (_, i) => ({ title: `Chapter ${i + 1}`, startOffsetMs: i * 600_000, lengthMs: 600_000 })) },
  description: "Never cached.",
});
const book = (id: string, title: string, author: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  subtitle: null,
  people: [person(author, "Author")],
  cover: { url: `https://images.audiobookdb.org/${id}.jpg` },
  releaseDate: "2011-06-15",
  description: `The description of ${title}.`,
  ...extra,
});

/** A member of a series answer: the book with its language, runtime and narrators, at its structured position. */
export function seriesMember(id: string, title: string, author: string, label: string, sortKey: number, extra: Record<string, unknown> = {}): FixtureMember {
  return {
    position: { label, sortKey },
    book: {
      id,
      title,
      people: [person(author, "Author"), person((extra.narrator as string) ?? "Jefferson Mays", "Narrator")],
      cover: { url: `https://images.audiobookdb.org/${id}.jpg` },
      releaseDate: (extra.releaseDate as string) ?? "2012-06-01",
      language: { code: (extra.language as string) ?? "en" },
      runtimeLengthMs: (extra.runtimeLengthMs as number) ?? 60_000_000,
      description: "Never cached.",
    },
  };
}
const corey = "James S. A. Corey";
/**
 * The Expanse as `GET /series/{id}` answers it (the ticket, 18 Nov: structured positions with sortKey 0.1, 1, 1.5, 2, …;
 * novellas included), shortened: a German translation listed as a member, and a book not out yet.
 */
export const EXPANSE_SERIES = (): FixtureSeries => ({
  id: "sr-expanse",
  name: "The Expanse",
  people: [person(corey, "Author")],
  bookCount: 7,
  books: [
    seriesMember("bk-drive", "Drive", corey, "0.1", 0.1, { runtimeLengthMs: 3_600_000 }),
    seriesMember("bk-leviathan", "Leviathan Wakes", corey, "1", 1, { runtimeLengthMs: 72_060_000 }),
    seriesMember("bk-butcher", "The Butcher of Anderson Station", corey, "1.5", 1.5, { runtimeLengthMs: 5_400_000 }),
    seriesMember("bk-calibans-war", "Caliban's War", corey, "2", 2),
    seriesMember("bk-leviathan-de", "Leviathan erwacht", corey, "1", 1, { language: "de", narrator: "Jürgen Holdorf" }),
    seriesMember("bk-abaddons-gate", "Abaddon's Gate", corey, "3", 3),
    seriesMember("bk-future", "The Last Expanse", corey, "10", 10, { releaseDate: "2999-01-01" }),
  ],
});
/**
 * Open Library's answer to `search.json?q=series:"The Expanse"` (recorded 19 Nov 2026, the six Expanse works and two
 * of the other results, fields as asked): Cibola Burn (4), Nemesis Games (5) and Persepolis Rising (7) have no
 * AudiobookDB member in the fixture, so they are the series' books with no audiobook yet.
 */
export const EXPANSE_OPEN_LIBRARY: OpenLibrarySeriesDoc[] = [
  { key: "/works/OL16117275W", title: "Caliban's war", author_name: [corey], first_publish_year: 2012, language: ["ita", "fre", "ger", "eng"], series_name: ["The Expanse"], series_position: ["2"] },
  { key: "/works/OL17857348W", title: "Persepolis rising", author_name: [corey], first_publish_year: 2017, language: ["eng"], series_name: ["The Expanse"], series_position: ["7"] },
  { key: "/works/OL16114008W", title: "Leviathan Wakes", author_name: [corey], first_publish_year: 2009, language: ["ita", "fre", "ger", "eng"], series_name: ["The Expanse"], series_position: ["1"] },
  { key: "/works/OL17074648W", title: "Abaddon’s Gate", author_name: [corey], first_publish_year: 2013, language: ["ita", "fre", "eng"], series_name: ["The Expanse"], series_position: ["3"] },
  { key: "/works/OL17793655W", title: "Nemesis Games", author_name: [corey], first_publish_year: 2015, language: ["eng", "ita"], series_name: ["The Expanse"], series_position: ["5"] },
  { key: "/works/OL17793652W", title: "Cibola burn", author_name: [corey], first_publish_year: 2014, language: ["eng", "ita"], series_name: ["The Expanse"], series_position: ["4"] },
  { key: "/works/OL8505461W", title: "The expanse of heaven", author_name: ["Richard A. Proctor"], language: ["eng"] },
  { key: "/works/OL20012345W", title: "The Expanse", author_name: ["Andy Diggle"], language: ["eng"] },
];

export const FIXTURE = {
  // Leviathan Wakes: an English release of 20 h 1 min (with an ASIN), an abridged English one of 8 h, a German one.
  leviathan: book("bk-leviathan", "Leviathan Wakes", "James S. A. Corey", {
    series: [{ series: { id: "sr-expanse", name: "The Expanse" }, position: { label: "1", sortKey: 1 } }],
    releases: [{ id: "rl-lw-en" }, { id: "rl-lw-short" }, { id: "rl-lw-de" }],
  }),
  // Two entries share the title and author: duplicates of one work (#754, owner 19 Nov), not rival candidates.
  duneA: book("bk-dune-a", "Dune", "Frank Herbert", { releases: [{ id: "rl-dune-a" }] }),
  duneB: book("bk-dune-b", "Dune", "Frank Herbert", { releases: [{ id: "rl-dune-b" }] }),
  // Only a German release.
  german: book("bk-german", "Der Schwarm", "Frank Schätzing", { releases: [{ id: "rl-schwarm" }] }),
  // Found by the ASIN in a file name.
  asinBook: book("bk-asin", "A Long Way Home", "Ida Vale", { releases: [{ id: "rl-asin" }] }),
  // The match page's own book (browser spec).
  feral: book("bk-feral", "Quiet Harbour", "Mira Sand", { releases: [{ id: "rl-feral" }] }),
  // Discover's "banks" (#721 part c2): two English audiobooks, one the server has (The Wasp Factory), and one in
  // German only, which the search answer marks as German and Discover leaves out.
  excession: book("bk-excession", "Excession", "Iain M. Banks", { releaseDate: "1996-08-01", releases: [{ id: "rl-excession" }] }),
  wasp: book("bk-wasp", "The Wasp Factory", "Iain Banks", { releaseDate: "1984-02-16", releases: [{ id: "rl-wasp" }] }),
  wespen: book("bk-wespen", "Die Wespenfabrik", "Iain Banks", { language: { code: "de", name: "German" }, releases: [{ id: "rl-wespen" }] }),
  // #754: the titles production's first batch match (19 Nov) left ambiguous. The work's own title carries a series
  // prefix ("Dungeon Crawler Carl, Book 2: …") or an omnibus label ("Star Wars Omnibus: …"); AudiobookDB's does not.
  dccOne: book("bk-dcc-1", "Dungeon Crawler Carl", "Matt Dinniman", {
    series: [{ series: { id: "sr-dcc", name: "Dungeon Crawler Carl" }, position: { label: "1", sortKey: 1 } }],
    releases: [{ id: "rl-dcc-1" }],
  }),
  dccTwo: book("bk-dcc-2", "Carl’s Doomsday Scenario", "Matt Dinniman", {
    series: [{ series: { id: "sr-dcc", name: "Dungeon Crawler Carl" }, position: { label: "2", sortKey: 2 } }],
    releases: [{ id: "rl-dcc-2" }],
  }),
  xwing: book("bk-xwing", "X-Wing: Rogue Squadron", "Michael A. Stackpole", { releases: [{ id: "rl-xwing" }] }),
  // 'The Beautiful Place' (Dinniman) had 2 candidates: two entries of the one work, the first with two releases.
  beautifulA: book("bk-beautiful-a", "The Beautiful Place", "Matt Dinniman", { releases: [{ id: "rl-beautiful-1" }, { id: "rl-beautiful-2" }] }),
  beautifulB: book("bk-beautiful-b", "The Beautiful Place", "Matt Dinniman", { releases: [{ id: "rl-beautiful-3" }] }),
  // The owner's example (19 Nov, production): three AudiobookDB entries of Meditations, one work; the one with the
  // most releases (8) is hTJnVwadQJUM. A collection with Meditations in it is another work.
  medDash: book("M8WaKdjCh86T", "Marcus Aurelius – Meditations", "Marcus Aurelius", { releases: [{ id: "rl-med-m8" }] }),
  medHyphen: book("4DqnhVBTt3iG", "Marcus Aurelius - Meditations", "Marcus Aurelius", { releases: [{ id: "rl-med-4d" }] }),
  medPlain: book("hTJnVwadQJUM", "Meditations", "Marcus Aurelius", { releases: Array.from({ length: 8 }, (_, i) => ({ id: `rl-med-h${i + 1}` })) }),
  // A number that is part of a title, not a place in a series: the title as written still finds it.
  fahrenheit: book("bk-fahrenheit", "Fahrenheit 451", "Ray Bradbury", { releases: [{ id: "rl-fahrenheit" }] }),
  classics: book("bk-classics", "The Classics Collection: Meditations, The Republic and The Prince", "Marcus Aurelius", {
    people: [person("Marcus Aurelius", "Author"), person("Plato", "Author"), person("Niccolò Machiavelli", "Author")],
    releases: [{ id: "rl-classics" }],
  }),
};
const RELEASES: Record<string, ReturnType<typeof release>> = {
  "rl-lw-en": release("rl-lw-en", "bk-leviathan", "Jefferson Mays", 72_060_000, "English", "B004GJ4ZPU", 55),
  "rl-lw-short": release("rl-lw-short", "bk-leviathan", "Jefferson Mays", 28_800_000, "English", null, 20),
  "rl-lw-de": release("rl-lw-de", "bk-leviathan", "Jürgen Holdorf", 70_000_000, "German", null, 50),
  "rl-dune-a": release("rl-dune-a", "bk-dune-a", "Scott Brick", 75_000_000, "English", null, 10),
  "rl-dune-b": release("rl-dune-b", "bk-dune-b", "Simon Vance", 76_000_000, "English", null, 10),
  "rl-schwarm": release("rl-schwarm", "bk-german", "Frank Glaubrecht", 60_000_000, "German", null, 10),
  "rl-asin": release("rl-asin", "bk-asin", "Mara Lind", 36_000_000, "English", "B0ASINFIX1", 12),
  "rl-feral": release("rl-feral", "bk-feral", "Rowan Hale", 40_000_000, "English", "B0FERAL001", 30),
  "rl-excession": release("rl-excession", "bk-excession", "Peter Kenny", 57_600_000, "English", null, 20),
  "rl-wasp": release("rl-wasp", "bk-wasp", "Peter Kenny", 28_800_000, "English", null, 12),
  "rl-wespen": release("rl-wespen", "bk-wespen", "Frank Arnold", 28_000_000, "German", null, 12),
  "rl-dcc-1": release("rl-dcc-1", "bk-dcc-1", "Jeff Hays", 49_000_000, "English", null, 20),
  "rl-dcc-2": release("rl-dcc-2", "bk-dcc-2", "Jeff Hays", 50_000_000, "English", null, 20),
  "rl-xwing": release("rl-xwing", "bk-xwing", "Marc Thompson", 30_000_000, "English", null, 12),
  "rl-beautiful-1": release("rl-beautiful-1", "bk-beautiful-a", "Jeff Hays", 20_000_000, "English", null, 10),
  "rl-beautiful-2": release("rl-beautiful-2", "bk-beautiful-a", "Jeff Hays", 8_000_000, "English", null, 5),
  "rl-beautiful-3": release("rl-beautiful-3", "bk-beautiful-b", "Jeff Hays", 26_000_000, "English", null, 12),
  "rl-med-m8": release("rl-med-m8", "M8WaKdjCh86T", "Duncan Steen", 15_000_000, "English", null, 12),
  "rl-med-4d": release("rl-med-4d", "4DqnhVBTt3iG", "Robin Homer", 16_200_000, "English", null, 12),
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`rl-med-h${i + 1}`, release(`rl-med-h${i + 1}`, "hTJnVwadQJUM", `Narrator ${i + 1}`, 18_000_000 + i * 3_600_000, "English", null, 12)])),
  "rl-fahrenheit": release("rl-fahrenheit", "bk-fahrenheit", "Tim Robbins", 18_600_000, "English", null, 10),
  "rl-classics": release("rl-classics", "bk-classics", "Various", 90_000_000, "English", null, 40),
};
const BOOKS: Record<string, ReturnType<typeof book> & { releases?: unknown }> = Object.fromEntries(Object.values(FIXTURE).map((entry) => [entry.id, entry]));
const ASINS: Record<string, { bookId: string; releaseId: string }> = {
  B004GJ4ZPU: { bookId: "bk-leviathan", releaseId: "rl-lw-en" },
  B0ASINFIX1: { bookId: "bk-asin", releaseId: "rl-asin" },
};
const fold = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
function searchBooks(q: string) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  return Object.values(BOOKS)
    .filter((entry) => {
      const hay = fold(`${entry.title} ${entry.people.map((p) => p.name).join(" ")}`).replace(/[^a-z0-9 ]/g, "");
      return words.every((word) => hay.includes(word.replace(/[^a-z0-9]/g, "")));
    })
    .slice(0, 10)
    .map(({ releases: _releases, ...rest }) => rest);
}

const OPEN_LIBRARY_DOCS = [
  { key: "/works/OL27448W", title: "The Quiet Shelf", author_name: ["Nora Reader"], author_key: ["OL302A"], first_publish_year: 1999, cover_i: 12345, language: ["eng"] },
  { key: "/works/OL1000W", title: "Quiet Harbour", author_name: ["Mira Sand"], first_publish_year: 2021, language: ["eng"] },
  { key: "/works/OL2000W", title: "Wilde Götter", author_name: ["Mira Sand"], first_publish_year: 2022, language: ["ger"] },
  // Discover's "banks" (#721 part c2): a book without an audiobook, and Excession, which AudiobookDB has too.
  { key: "/works/OL3000W", title: "The Bridge", author_name: ["Iain Banks"], author_key: ["OL300A"], first_publish_year: 1986, cover_i: 30000, language: ["eng"] },
  { key: "/works/OL3001W", title: "Excession", author_name: ["Iain M. Banks"], author_key: ["OL301A"], first_publish_year: 1996, language: ["eng"] },
];
const OPEN_LIBRARY_AUTHORS: Record<string, string> = { OL300A: "Iain Banks", OL301A: "Iain M. Banks", OL302A: "Nora Reader" };

// ---- Google Books (volumes API) ----
/** The answer a key-less call got on 19 Nov (trimmed): the shared project's day was spent. */
export const GOOGLE_DAILY_LIMIT_BODY = JSON.stringify({
  error: {
    code: 429,
    message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'books.googleapis.com' for consumer 'project_number:624717413613'.",
    errors: [{ message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'books.googleapis.com' for consumer 'project_number:624717413613'.", domain: "global", reason: "rateLimitExceeded" }],
    status: "RESOURCE_EXHAUSTED",
  },
});
const volume = (id: string, title: string, authors: string[], language: string, publishedDate: string) => ({
  kind: "books#volume",
  id,
  etag: `etag-${id}`,
  selfLink: `https://www.googleapis.com/books/v1/volumes/${id}`,
  volumeInfo: {
    title,
    authors,
    publisher: "Harbour Press",
    publishedDate,
    description: `<p>The <b>Google Books</b> description of ${title}.</p>`,
    industryIdentifiers: [{ type: "ISBN_13", identifier: "9781000000002" }],
    pageCount: 320,
    printType: "BOOK",
    categories: ["Fiction"],
    imageLinks: {
      smallThumbnail: `http://books.google.com/books/content?id=${id}&printsec=frontcover&img=1&zoom=5&edge=curl&source=gbs_api`,
      thumbnail: `http://books.google.com/books/content?id=${id}&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api`,
    },
    language,
    canonicalVolumeLink: `https://play.google.com/store/books/details?id=${id}`,
  },
  searchInfo: { textSnippet: `An excerpt of ${title}.` },
});
export const GOOGLE_VOLUMES = [
  volume("gbQuiet01", "Quiet Harbour", ["Mira Sand"], "en", "2021-03-02"),
  // The German edition under the same title: only the English check leaves it out.
  volume("gbQuietDe", "Quiet Harbour", ["Mira Sand"], "de", "2022"),
  volume("gbLeviat1", "Leviathan Wakes", ["James S. A. Corey"], "en", "2011-06-15"),
];

// ---- iTunes (Search API), trimmed from the live answer of 19 Nov ----
const audiobook = (collectionId: number, collectionName: string, artistName: string, releaseDate: string) => ({
  wrapperType: "audiobook",
  artistId: 433411981,
  collectionId,
  artistName,
  collectionName,
  collectionCensoredName: collectionName,
  artistViewUrl: `https://books.apple.com/us/author/id433411981?uo=4`,
  collectionViewUrl: `https://books.apple.com/us/audiobook/id${collectionId}?uo=4`,
  artworkUrl60: `https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/a1/e3/${collectionId}.jpg/60x60bb.jpg`,
  artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/a1/e3/${collectionId}.jpg/100x100bb.jpg`,
  collectionPrice: 32.99,
  collectionExplicitness: "cleaned",
  trackCount: 1,
  country: "USA",
  currency: "USD",
  releaseDate,
  primaryGenreName: "Sci-Fi & Fantasy",
  previewUrl: `https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview116/${collectionId}.m4a`,
  description: `<b>The iTunes description of ${collectionName}.</b><br />Read in full.`,
});
export const ITUNES_AUDIOBOOKS = [
  audiobook(1441934342, "Leviathan Wakes", "James S. A. Corey", "2017-06-06T07:00:00Z"),
  audiobook(1500000001, "Quiet Harbour", "Mira Sand", "2021-04-01T07:00:00Z"),
  audiobook(1500000002, "The Lighthouse at Noon", "Mira Sand", "2023-09-12T07:00:00Z"),
];
/** Google Books fails at the network for a search with this word (never cached, so every run sees the failure). */
export const GOOGLE_OFFLINE_WORD = "lighthouse";

export function createControl(): FixtureControl {
  return {
    calls: [],
    failNext: [],
    offline: false,
    remaining: 39,
    gone: new Set(),
    series: new Map([["sr-expanse", EXPANSE_SERIES()]]),
    openLibrarySeries: new Map([["the expanse", EXPANSE_OPEN_LIBRARY]]),
    failGoogle: [],
    failItunes: [],
  };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** A fetch that answers api.audiobookdb.org and openlibrary.org from the recorded answers, and passes the rest on. */
export function fixtureFetch(control: FixtureControl, passThrough: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (url.hostname === "api.audiobookdb.org") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      control.calls.push({ url: url.href, method, headers, body });
      if (control.offline) throw new TypeError("fetch failed");
      const limits = { "RateLimit-Limit": "40", "RateLimit-Remaining": String(control.remaining), "RateLimit-Reset": "1" };
      const failure = control.failNext.shift();
      if (failure) return new Response(failure.body ?? "{}", { status: failure.status, headers: { ...limits, ...failure.headers } });
      if (!headers["x-api-key"]) return json({ error: "API key required" }, 401, limits);
      const path = url.pathname.replace(/^\/api/, "");
      if (method === "POST" && path === "/search") {
        if (body?.type === "series") {
          const words = fold(String(body?.q ?? "")).split(/\s+/).filter(Boolean);
          const found = [...control.series.values()]
            .filter((entry) => words.every((word) => fold(entry.name).includes(word)))
            .slice(0, 10)
            .map(({ books, ...head }) => ({ ...head, bookCount: head.bookCount ?? books.length, cover: books[0]?.book.cover ?? null }));
          return json({ results: { series: found } }, 200, limits);
        }
        return json({ results: { books: searchBooks(String(body?.q ?? "")) } }, 200, limits);
      }
      const bookMatch = path.match(/^\/books\/([^/]+)$/);
      if (bookMatch) {
        const id = decodeURIComponent(bookMatch[1]);
        // A series member is a book too.
        const member = [...control.series.values()].flatMap((entry) => entry.books).find((entry) => entry.book.id === id)?.book;
        const found = BOOKS[id] ?? member;
        return found && !control.gone.has(id) ? json(found, 200, limits) : json({ error: "Not found" }, 404, limits);
      }
      const releaseMatch = path.match(/^\/releases\/([^/]+)$/);
      if (releaseMatch) {
        const id = decodeURIComponent(releaseMatch[1]);
        return RELEASES[id] && !control.gone.has(id) ? json(RELEASES[id], 200, limits) : json({ error: "Not found" }, 404, limits);
      }
      const seriesMatch = path.match(/^\/series\/([^/]+)$/);
      if (seriesMatch) {
        const id = decodeURIComponent(seriesMatch[1]);
        const entry = control.series.get(id);
        return entry && !control.gone.has(id) ? json(entry, 200, limits) : json({ error: "Not found" }, 404, limits);
      }
      const asinMatch = path.match(/^\/audiobooks\/external\/audible\/([^/]+)$/);
      if (asinMatch) {
        const hit = ASINS[asinMatch[1]];
        return hit ? json({ book: { id: hit.bookId }, release: { id: hit.releaseId } }, 200, limits) : json({ error: "Not found" }, 404, limits);
      }
      return json({ error: "Not found" }, 404, limits);
    }
    if (url.hostname === "openlibrary.org") {
      control.calls.push({ url: url.href, method, headers, body: null });
      const seriesQuery = url.pathname === "/search.json" ? (url.searchParams.get("q") ?? "").match(/^series:"(.*)"$/) : null;
      if (seriesQuery) {
        const docs = control.openLibrarySeries.get(seriesQuery[1].toLowerCase()) ?? [];
        return json({ numFound: docs.length, start: 0, docs });
      }
      if (url.pathname === "/search.json") {
        const words = fold(url.searchParams.get("q") ?? "").split(/\s+/).filter(Boolean);
        const docs = OPEN_LIBRARY_DOCS.filter((doc) => words.every((word) => fold(`${doc.title} ${doc.author_name.join(" ")}`).includes(word)));
        return json({ numFound: docs.length, start: 0, docs });
      }
      const work = url.pathname.match(/^\/works\/(OL\d+W)\.json$/);
      const doc = work && OPEN_LIBRARY_DOCS.find((entry) => entry.key === `/works/${work[1]}`);
      if (doc)
        return json({
          key: doc.key,
          title: doc.title,
          description: { type: "/type/text", value: `About ${doc.title}.` },
          covers: doc.cover_i ? [doc.cover_i] : [],
          authors: (("author_key" in doc ? doc.author_key : undefined) ?? []).map((key) => ({ type: { key: "/type/author_role" }, author: { key: `/authors/${key}` } })),
          first_publish_date: String(doc.first_publish_year),
        });
      const author = url.pathname.match(/^\/authors\/(OL\d+A)\.json$/);
      if (author && OPEN_LIBRARY_AUTHORS[author[1]]) return json({ key: `/authors/${author[1]}`, name: OPEN_LIBRARY_AUTHORS[author[1]] });
      return json({ error: "notfound" }, 404);
    }
    if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/books/v1/")) {
      control.calls.push({ url: url.href, method, headers, body: null });
      const failure = control.failGoogle.shift();
      if (failure) return new Response(failure.body ?? "{}", { status: failure.status, headers: { "Content-Type": "application/json; charset=UTF-8", ...failure.headers } });
      const path = url.pathname.slice("/books/v1".length);
      if (path === "/volumes") {
        const q = fold(url.searchParams.get("q") ?? "");
        if (q.includes(GOOGLE_OFFLINE_WORD)) throw new TypeError("fetch failed");
        const words = q.split(/\s+/).filter(Boolean);
        const items = GOOGLE_VOLUMES.filter((entry) => words.every((word) => fold(`${entry.volumeInfo.title} ${entry.volumeInfo.authors.join(" ")}`).includes(word)));
        // langRestrict is honoured loosely, as Google does: the German volume still comes back.
        return json(items.length ? { kind: "books#volumes", totalItems: items.length, items } : { kind: "books#volumes", totalItems: 0 });
      }
      const one = path.match(/^\/volumes\/([^/]+)$/);
      const found = one && !control.gone.has(one[1]) && GOOGLE_VOLUMES.find((entry) => entry.id === one[1]);
      if (found) return json(found);
      return json({ error: { code: 404, message: "The volume ID could not be found.", status: "NOT_FOUND" } }, 404);
    }
    if (url.hostname === "itunes.apple.com") {
      control.calls.push({ url: url.href, method, headers, body: null });
      const failure = control.failItunes.shift();
      if (failure) return new Response(failure.body ?? "", { status: failure.status, headers: failure.headers });
      const answer = (results: unknown[]) => new Response(`\n\n\n${JSON.stringify({ resultCount: results.length, results })}\n`, { status: 200, headers: { "Content-Type": "text/javascript; charset=utf-8" } });
      if (url.pathname === "/search") {
        const term = fold(url.searchParams.get("term") ?? "");
        const words = term.split(/\s+/).filter(Boolean);
        return answer(ITUNES_AUDIOBOOKS.filter((entry) => words.every((word) => fold(`${entry.collectionName} ${entry.artistName}`).includes(word))));
      }
      if (url.pathname === "/lookup") {
        const id = url.searchParams.get("id") ?? "";
        return answer(control.gone.has(id) ? [] : ITUNES_AUDIOBOOKS.filter((entry) => String(entry.collectionId) === id));
      }
      return new Response("", { status: 404 });
    }
    return passThrough(input, init);
  };
}

/** The browser server: the recorded answers in place of both providers. */
export function installAudiobookDbFixture(): FixtureControl {
  const control = createControl();
  globalThis.fetch = fixtureFetch(control, globalThis.fetch.bind(globalThis));
  return control;
}
