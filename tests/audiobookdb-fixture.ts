// Test-only AudiobookDB and Open Library answers (#721). No live call is made in a test: the AudiobookDB answers
// follow the fields the ticket recorded from the docs and anonymous calls on 18 Nov (search wrapped per type, a
// book's releases, a release's people with roles, external ids, chapterDetail); the Open Library ones follow its
// documented search.json and works/{id}.json. Never bundled into the production server.

export type FixtureCall = { url: string; method: string; headers: Record<string, string>; body: unknown };
export type FixtureControl = {
  calls: FixtureCall[];
  /** The next AudiobookDB answers: a status (with headers) instead of the recorded one. */
  failNext: { status: number; headers?: Record<string, string>; body?: string }[];
  /** Every AudiobookDB request fails at the network. */
  offline: boolean;
  /** The RateLimit-Remaining the next answers carry. */
  remaining: number;
  /** Ids AudiobookDB no longer has (404). */
  gone: Set<string>;
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
  feral: book("bk-feral", "Feral Gods", "Ada North", { releases: [{ id: "rl-feral" }] }),
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
  { key: "/works/OL1000W", title: "Feral Gods", author_name: ["Ada North"], first_publish_year: 2021, language: ["eng"] },
  { key: "/works/OL2000W", title: "Wilde Götter", author_name: ["Ada North"], first_publish_year: 2022, language: ["ger"] },
];

export function createControl(): FixtureControl {
  return { calls: [], failNext: [], offline: false, remaining: 39, gone: new Set() };
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
    return passThrough(input, init);
  };
}

/** The browser server: the recorded answers in place of both providers. */
export function installAudiobookDbFixture(): FixtureControl {
  const control = createControl();
  globalThis.fetch = fixtureFetch(control, globalThis.fetch.bind(globalThis));
  return control;
}
