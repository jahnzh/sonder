import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Search,
  Loader2,
  ExternalLink,
  ArrowDown,
  Headphones,
} from "lucide-react";
import { api, localDB } from "../lib";
import { Dialog } from "./ui/dialog";
import type {
  Acquisition,
  AudiobookRelease,
  ReleaseSourceStatus,
} from "../types";
import {
  matchesLanguage,
  mergeReleases,
  releaseIndexers,
  sortReleases,
} from "../releases";

export function ReleasePicker({
  query,
  onQuery,
  prowlarrConfigured = false,
  onQueued,
  refresh,
  notify,
  searchAtOnce = false,
}: {
  /** Search for the query when shown (Discover's "Search for a recording", #575). */
  searchAtOnce?: boolean;
  query: string;
  onQuery: (query: string) => void;
  prowlarrConfigured?: boolean;
  onQueued: () => void;
  refresh: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [results, setResults] = useState<AudiobookRelease[]>([]);
  const [language, setLanguage] = useState("English");
  const [pending, setPending] = useState(0);
  const busy = pending > 0;
  const [sourceErrors, setSourceErrors] = useState<ReleaseSourceStatus[]>([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [selected, setSelected] = useState<AudiobookRelease | null>(null);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [queuing, setQueuing] = useState(false);
  const requestId = useRef(0);
  const chooseId = useRef(0);
  const search = async (page = 1, term = query) => {
    if (term.trim().length < 2) {
      setError("Enter at least two characters to search.");
      return;
    }
    const id = ++requestId.current;
    setError("");
    if (page === 1) {
      setResults([]);
      setNextPage(null);
      setSourceErrors([]);
      setSearchedQuery(term.trim());
    }
    // Each source fills in as it answers; one failing source never hides the others.
    const sources: {
      source: ReleaseSourceStatus["source"];
      label: string;
      path: string;
    }[] = [
      {
        source: "abb",
        label: "AudioBookBay",
        path:
          "/discover/abb/releases?" +
          new URLSearchParams({ q: term.trim(), page: String(page) }),
      },
      ...(prowlarrConfigured && page === 1
        ? [
            {
              source: "prowlarr" as const,
              label: "Prowlarr",
              path:
                "/discover/prowlarr/releases?" +
                new URLSearchParams({ q: term.trim() }),
            },
          ]
        : []),
    ];
    setPending(sources.length);
    await Promise.all(
      sources.map(async ({ source, label, path }) => {
        try {
          const response = await api<{
            results: AudiobookRelease[];
            nextPage: number | null;
          }>(path);
          if (id !== requestId.current) return;
          setResults((current) =>
            mergeReleases(
              current,
              response.results.map((release) => ({
                ...release,
                source: release.source || source,
              })),
            ),
          );
          if (source === "abb") setNextPage(response.nextPage);
        } catch (error) {
          if (id === requestId.current)
            setSourceErrors((current) => [
              ...current.filter((entry) => entry.source !== source),
              { source, label, error: (error as Error).message },
            ]);
        } finally {
          if (id === requestId.current) {
            setPending((count) => count - 1);
            setSearched(true);
          }
        }
      }),
    );
  };
  useEffect(() => {
    void localDB.preferences.get("release-language").then((value) => {
      if (typeof value?.value === "string") setLanguage(value.value);
    });
  }, []);
  useEffect(() => {
    if (searchAtOnce) void search();
    // Once, for the query it was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(
    () => () => {
      requestId.current++;
      chooseId.current++;
    },
    [],
  );
  const choose = async (release: AudiobookRelease) => {
    const id = ++chooseId.current;
    setSelected(release);
    setDetailsError("");
    if (release.source === "prowlarr") { setDetailsBusy(false); return; }
    setDetailsBusy(true);
    try {
      const details = await api<AudiobookRelease>(
        "/discover/abb/releases/" + encodeURIComponent(release.id),
      );
      if (id === chooseId.current)
        setSelected((current) =>
          current
            ? {
                ...current,
                ...Object.fromEntries(
                  Object.entries(details).filter(
                    ([, value]) => value != null && value !== "",
                  ),
                ),
              }
            : null,
        );
    } catch (error) {
      if (id === chooseId.current) setDetailsError((error as Error).message);
    } finally {
      if (id === chooseId.current) setDetailsBusy(false);
    }
  };
  const queue = async () => {
    if (!selected) return;
    setQueuing(true);
    try {
      const job = await api<Acquisition>(
        selected.source === "prowlarr"
          ? "/discover/prowlarr/add"
          : "/discover/abb/add",
        {
          method: "POST",
          body: JSON.stringify({
            ...(selected.source === "prowlarr"
              ? { id: selected.id }
              : { slug: selected.id }),
          }),
        },
      );
      if (job.status === "error")
        throw new Error(
          job.error ||
            "This release could not be queued. Choose another release or retry.",
        );
      notify(
        job.status === "ready"
          ? "Your chosen release is ready to listen."
          : job.backend === "torbox"
            ? "Preparing your chosen release from TorBox’s cache."
            : "Your chosen release is downloading to the HDD through the local torrent client.",
      );
      setSelected(null);
      await refresh();
      onQueued();
    } catch (error) {
      setDetailsError((error as Error).message);
    } finally {
      setQueuing(false);
    }
  };
  const languages = [
    ...new Set([
      "English",
      ...results.map((release) => release.language || "Unknown"),
    ]),
  ].sort();
  const visible = sortReleases(
    results.filter((release) => matchesLanguage(release, language)),
    searchedQuery,
  );
  return (
    <section className="release-picker external-search">
      <div className="section-heading">
        <h2>Find the right audiobook release</h2>
      </div>
      <p>
        Compare language, format and narration before choosing. Cached releases
        stream through TorBox; others download to your server’s HDD.
      </p>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="search-input">
          <Search size={18} />
          <input
            aria-label="Search audiobook releases"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Book title or author"
            minLength={2}
            maxLength={150}
          />
        </label>
        <button className="button primary" disabled={busy}>
          {busy ? <Loader2 size={17} className="spin" /> : <Search size={17} />}{" "}
          Search
        </button>
      </form>
      <div className="release-filters">
        <label>
          Language
          <select
            aria-label="Release language"
            value={language}
            onChange={(event) => {
              setLanguage(event.target.value);
              void localDB.preferences.put({
                key: "release-language",
                value: event.target.value,
              });
            }}
          >
            <option value="all">All languages</option>
            {[
              ...new Set([
                ...languages,
                ...(language !== "all" ? [language] : []),
              ]),
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <span>
          {visible.length} of {results.length} loaded releases
        </span>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {sourceErrors.map((entry) => (
        <p className="release-source-error" role="status" key={entry.source}>
          {entry.label} unavailable: {entry.error}
        </p>
      ))}
      <div className="release-results">
        {visible.map((release) => (
          <article className="release-card" key={release.id}>
            <img
              src={release.cover || "/covers/time.svg"}
              alt=""
              onError={(event) => {
                event.currentTarget.src = "/covers/time.svg";
              }}
            />
            <div className="release-info">
              <h3>{release.title}</h3>
              {release.author && <p>{release.author}</p>}
              <ReleaseFacts release={release} />
              <ReleaseSource release={release} />
              {release.narrator && <p>Narrated by {release.narrator}</p>}
              {release.uploader && (
                <small>
                  Shared by {release.uploader}
                  {release.posted ? ` · ${release.posted}` : ""}
                </small>
              )}
            </div>
            <button
              className="button subtle"
              onClick={() => void choose(release)}
            >
              <Headphones size={14} /> Choose release
            </button>
          </article>
        ))}
      </div>
      {busy && (
        <p className="release-loading" role="status">
          <Loader2 size={18} className="spin" /> Finding releases…
        </p>
      )}
      {searched && !busy && !visible.length && sourceErrors.length < (prowlarrConfigured ? 2 : 1) && (
        <p className="queue-empty">
          {results.length
            ? "No releases in this language on the loaded pages. Load more releases or choose All languages."
            : "No releases found. Try the title without the author or a shorter search."}
        </p>
      )}
      {nextPage && (
        <button
          className="button subtle release-more"
          disabled={busy}
          onClick={() => void search(nextPage, searchedQuery)}
        >
          <ArrowDown size={15} /> Load more releases
        </button>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !queuing) {
            chooseId.current++;
            setSelected(null);
          }
        }}
        title="Choose this audiobook release"
        description="Check the language and narration"
        className="release-dialog"
      >
        {selected && (
          <>
            <h2>{selected.title}</h2>
            {selected.author && <p>{selected.author}</p>}
            <ReleaseFacts release={selected} />
            <ReleaseSource release={selected} />
            <p>
              Narrator: {selected.narrator || "Not provided by this source"}
            </p>
            {selected.posted && (
              <p>
                Posted {selected.posted}
                {selected.uploader ? ` by ${selected.uploader}` : ""}
              </p>
            )}
            {detailsBusy ? (
              <p role="status">
                <Loader2 className="spin" size={16} /> Reading release details…
              </p>
            ) : (
              selected.description && (
                <p className="release-description">{selected.description}</p>
              )
            )}
            {detailsError && (
              <p className="inline-error" role="alert">
                {detailsError}
              </p>
            )}
            {selected.url && (
              <a
                className="text-link"
                href={selected.url}
                target="_blank"
                rel="noreferrer"
              >
                View source details <ExternalLink size={14} />
              </a>
            )}
            <p className="release-storage-note">
              We’ll check this exact release in TorBox. A cache miss downloads
              through the local torrent client to your 4 TB drive. Each
              recording keeps its own listening position.
            </p>
            <button
              className="button primary"
              disabled={detailsBusy || queuing}
              onClick={() => void queue()}
            >
              {queuing ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Headphones size={16} />
              )}{" "}
              {queuing ? "Preparing release…" : "Use this release"}
            </button>
          </>
        )}
      </Dialog>
    </section>
  );
}
function ReleaseFacts({ release }: { release: AudiobookRelease }) {
  return (
    <div className="release-facts">
      <span className="release-language">
        {release.language || "Language unknown"}
      </span>
      {[
        release.format,
        release.bitrate && release.bitrate !== "?" ? release.bitrate : null,
        release.size,
      ]
        .filter(Boolean)
        .map((fact, index) => (
          <span key={index}>{fact}</span>
        ))}
    </div>
  );
}
function ReleaseSource({ release }: { release: AudiobookRelease }) {
  return (
    <small className="release-source">
      {[
        releaseIndexers(release).join(", "),
        typeof release.seeders === "number"
          ? `${release.seeders} ${release.seeders === 1 ? "seeder" : "seeders"}`
          : null,
        release.cached ? "Cached on TorBox" : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    </small>
  );
}
