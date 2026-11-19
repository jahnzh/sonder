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
  /** The next Google Books / iTunes answers: a status (with headers and body) instead of the recorded one. */
  failGoogle: { status: number; headers?: Record<string, string>; body?: string }[];
  failItunes: { status: number; headers?: Record<string, string>; body?: string }[];
};

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

export const FIXTURE = {
  // Leviathan Wakes: an English release of 20 h 1 min (with an ASIN), an abridged English one of 8 h, a German one.
  leviathan: book("bk-leviathan", "Leviathan Wakes", "James S. A. Corey", {
    series: [{ series: { id: "sr-expanse", name: "The Expanse" }, position: { label: "1", sortKey: 1 } }],
    releases: [{ id: "rl-lw-en" }, { id: "rl-lw-short" }, { id: "rl-lw-de" }],
  }),
  // Two different books share the title and author: not sure.
  duneA: book("bk-dune-a", "Dune", "Frank Herbert", { releases: [{ id: "rl-dune-a" }] }),
  duneB: book("bk-dune-b", "Dune", "Frank Herbert", { releases: [{ id: "rl-dune-b" }] }),
  // Only a German release.
  german: book("bk-german", "Der Schwarm", "Frank Schätzing", { releases: [{ id: "rl-schwarm" }] }),
  // Found by the ASIN in a file name.
  asinBook: book("bk-asin", "A Long Way Home", "Ida Vale", { releases: [{ id: "rl-asin" }] }),
  // The match page's own book (browser spec).
  feral: book("bk-feral", "Quiet Harbour", "Mira Sand", { releases: [{ id: "rl-feral" }] }),
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
  { key: "/works/OL27448W", title: "The Quiet Shelf", author_name: ["Nora Reader"], first_publish_year: 1999, cover_i: 12345, language: ["eng"] },
  { key: "/works/OL1000W", title: "Quiet Harbour", author_name: ["Mira Sand"], first_publish_year: 2021, language: ["eng"] },
  { key: "/works/OL2000W", title: "Wilde Götter", author_name: ["Mira Sand"], first_publish_year: 2022, language: ["ger"] },
];

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
  volume("gbQuietDe", "Stiller Hafen", ["Mira Sand"], "de", "2022"),
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
/** The browser spec's slow group: an iTunes search for these words answers after this long. */
export const ITUNES_SLOW_WORD = "lighthouse";
export const ITUNES_SLOW_MS = 1500;
/** And Google Books fails at the network for them, so its failure line shows while iTunes is still searching. */
export const GOOGLE_OFFLINE_WORD = "lighthouse";

export function createControl(): FixtureControl {
  return { calls: [], failNext: [], offline: false, remaining: 39, gone: new Set(), failGoogle: [], failItunes: [] };
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
        if (body?.type === "series") return json({ results: { series: [{ id: "sr-expanse", name: "The Expanse", bookCount: 18 }] } }, 200, limits);
        return json({ results: { books: searchBooks(String(body?.q ?? "")) } }, 200, limits);
      }
      const bookMatch = path.match(/^\/books\/([^/]+)$/);
      if (bookMatch) {
        const id = decodeURIComponent(bookMatch[1]);
        return BOOKS[id] && !control.gone.has(id) ? json(BOOKS[id], 200, limits) : json({ error: "Not found" }, 404, limits);
      }
      const releaseMatch = path.match(/^\/releases\/([^/]+)$/);
      if (releaseMatch) {
        const id = decodeURIComponent(releaseMatch[1]);
        return RELEASES[id] && !control.gone.has(id) ? json(RELEASES[id], 200, limits) : json({ error: "Not found" }, 404, limits);
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
      if (url.pathname === "/search.json") {
        const words = fold(url.searchParams.get("q") ?? "").split(/\s+/).filter(Boolean);
        const docs = OPEN_LIBRARY_DOCS.filter((doc) => words.every((word) => fold(`${doc.title} ${doc.author_name.join(" ")}`).includes(word)));
        return json({ numFound: docs.length, start: 0, docs });
      }
      const work = url.pathname.match(/^\/works\/(OL\d+W)\.json$/);
      const doc = work && OPEN_LIBRARY_DOCS.find((entry) => entry.key === `/works/${work[1]}`);
      if (doc) return json({ key: doc.key, title: doc.title, description: { type: "/type/text", value: `About ${doc.title}.` }, covers: doc.cover_i ? [doc.cover_i] : [] });
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
        if (term.includes(ITUNES_SLOW_WORD)) await new Promise((resolve) => setTimeout(resolve, ITUNES_SLOW_MS));
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
