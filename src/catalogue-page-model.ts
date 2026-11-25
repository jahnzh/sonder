// The words and rules of the catalogue match page (#721, `#book/<workId>/match`; part e adds Google Books and iTunes)
// and of the catalogue providers in Settings › Connections. Pure: no fetch, no React. The answers' shapes are those of server/catalogue-routes.ts.

export type CatalogueProvider = "audiobookdb" | "openlibrary" | "googlebooks" | "itunes";
/** The providers the match page searches, in its order: one request and one group each. */
export const SEARCH_PROVIDERS = ["audiobookdb", "openlibrary", "googlebooks", "itunes"] as const satisfies readonly CatalogueProvider[];
/** A group of the search: its results, or the provider's own reason. */
export type SearchGroup = { results: CatalogueResult[]; error: string | null };
export type CatalogueResult = {
  provider: CatalogueProvider;
  id: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  narrators: string[];
  cover: string | null;
  year: number | null;
  series: { name: string; position: string | null } | null;
};
export type CatalogueSearch = Partial<Record<CatalogueProvider, SearchGroup>>;
/** A Google Books or iTunes link, beside the main one. */
export type ProviderLink = { provider: "googlebooks" | "itunes"; id: string; title: string; author: string; matchedBy: "manual"; url: string };
export type ReleaseLink = { releaseId: string; narrator: string | null; lengthMs: number | null; asin: string | null; chapters: number; matchedBy: "asin" | "length" | "manual" };
export type WorkCatalogue = {
  workId: string;
  title: string;
  author: string;
  query: string;
  link: {
    provider: CatalogueProvider;
    id: string;
    title: string;
    author: string;
    series: { name: string; position: string | null } | null;
    matchedBy: "title" | "asin" | "manual";
    url: string;
    /** The other AudiobookDB entries of the same work (#754); absent from servers that predate them. */
    duplicates?: { id: string; title: string; releases: number; url?: string }[];
  } | null;
  /** Google Books and iTunes (part e); absent from servers that predate them. */
  links?: ProviderLink[];
  outcome: { outcome: "matched" | "ambiguous" | "missing" | "failed"; reason: string | null; candidates: number } | null;
  recordings: { recordingId: string; label: string; durationMs: number; narrator: string; release: ReleaseLink | null }[];
  releases: { id: string; bookId?: string | null; narrators: string[]; lengthMs: number | null; asin: string | null; language: string | null; abridged: boolean | null; chapters: number }[];
  releasesError: string | null;
};
export type BatchAnswer = {
  status: { running: boolean; startedAt: number | null; finishedAt: number | null; done: number; total: number; matched: number; error: string | null };
  unmatched: { workId: string; title: string; author: string; outcome: "ambiguous" | "missing" | "failed"; reason: string | null; candidates: number }[];
  unitsToday: number;
};

export const PROVIDER_NAMES: Record<CatalogueProvider, string> = { audiobookdb: "AudiobookDB", openlibrary: "Open Library", googlebooks: "Google Books", itunes: "iTunes" };
/** The search field's name: what it searches. */
export const SEARCH_LABEL = "Search AudiobookDB, Open Library, Google Books and iTunes";
export const SEARCHING = "Searching";
export const KEY_IN_SERVER_FILE = "Set in the server's file";
export const KEY_NOT_NEEDED = "Not needed";
export const NOT_MATCHED = "Not matched";
export const NO_RELEASE = "None";
export const NO_RESULTS = "No books found";
export const ADMIN_ONLY_LINE = "The administrator matches books.";
export const CREDIT = "Data from AudiobookDB";

/** "20 h 1 min", "45 min". */
export function lengthLabel(ms: number | null | undefined): string | null {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? (rest ? `${hours} h ${rest} min` : `${hours} h`) : `${rest} min`;
}

/** The Book page's row value: the provider matched, or Not matched. */
export function matchRowValue(link: WorkCatalogue["link"] | null | undefined): string {
  return link ? PROVIDER_NAMES[link.provider] : NOT_MATCHED;
}

/** The line under the match: how it was matched, or what the batch found. */
export function outcomeLine(answer: Pick<WorkCatalogue, "link" | "outcome" | "links">): { text: string; failed: boolean } | null {
  // Only a Google Books or iTunes link: those are picked by hand.
  if (!answer.link && answer.links?.length) return { text: "Matched by hand", failed: false };
  if (answer.link) {
    const how = answer.link.matchedBy === "asin" ? "Matched by the ASIN in the file names" : answer.link.matchedBy === "title" ? "Matched by title and author" : "Matched by hand";
    return { text: how, failed: false };
  }
  const outcome = answer.outcome;
  if (!outcome) return null;
  if (outcome.outcome === "failed") return { text: outcome.reason ?? "The match failed", failed: true };
  if (outcome.outcome === "ambiguous") return { text: outcome.candidates > 1 ? `Several books fit · ${outcome.candidates}` : "No exact match · pick one", failed: false };
  if (outcome.outcome === "missing") return { text: outcome.reason ?? "Not found on AudiobookDB or Open Library", failed: false };
  return null;
}

/** "Several books fit", "Not found", the failure: the value of a row in the list of works not matched. */
export function unmatchedValue(entry: BatchAnswer["unmatched"][number]): string {
  if (entry.outcome === "ambiguous") return entry.candidates > 1 ? "Several fit" : "Not sure";
  if (entry.outcome === "failed") return "Failed";
  return "Not found";
}

/** The value `provider:id` a result or a link is chosen by in the search. */
export const choiceValue = (provider: CatalogueProvider, id: string) => `${provider}:${id}`;
/** The links a work already has, as choice values: picking one of them again changes nothing. */
export function currentChoices(answer: Pick<WorkCatalogue, "link" | "links">): string[] {
  return [...(answer.link ? [choiceValue(answer.link.provider, answer.link.id)] : []), ...(answer.links ?? []).map((link) => choiceValue(link.provider, link.id))];
}

/** The match's value: its title and author. */
export function linkLabel(link: NonNullable<WorkCatalogue["link"]> | ProviderLink): string {
  return [link.title, link.author].filter(Boolean).join(" · ");
}

/** A result's detail line: author, narrator, year, series and position. */
export function resultDetail(result: CatalogueResult): string {
  const series = result.series ? (result.series.position ? `${result.series.name} ${result.series.position}` : result.series.name) : null;
  return [result.authors.join(", "), result.narrators.length ? `read by ${result.narrators.join(", ")}` : null, result.year ? String(result.year) : null, series]
    .filter(Boolean)
    .join(" · ");
}

/** A release in the picker: its narrator, length and ASIN. */
export function releaseLabel(release: { narrators?: string[]; narrator?: string | null; lengthMs: number | null; asin: string | null; abridged?: boolean | null }): string {
  const narrator = release.narrators?.length ? release.narrators.join(", ") : release.narrator || "Narrator unknown";
  return [narrator, lengthLabel(release.lengthMs), release.abridged ? "Abridged" : null, release.asin].filter(Boolean).join(" · ");
}

/** The batch's line in Settings: running, done, or why it stopped. */
export function batchLine(status: BatchAnswer["status"]): { text: string; failed: boolean } | null {
  if (status.running) return { text: `Matching · ${status.done} of ${status.total}`, failed: false };
  if (status.error) return { text: status.error, failed: true };
  if (status.finishedAt) return { text: `Matched ${status.matched} of ${status.total}`, failed: false };
  return null;
}

/** Settings › Connections › AudiobookDB › Test. */
export function testedLine(answer: { remaining: number | null; limit: number | null; unitsToday: number }): string {
  return `AudiobookDB is connected · ${answer.unitsToday.toLocaleString("en-US")} of 10,000 units used today.`;
}
