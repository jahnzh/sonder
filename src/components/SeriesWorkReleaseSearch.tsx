import { useRef, useState, type FormEvent } from "react";
import { Loader2, Search } from "lucide-react";
import { ApiError, api } from "../lib";
import type { AudiobookRelease, ReleaseSourceStatus } from "../types";
import {
  matchesLanguage,
  mergeReleases,
  releaseIndexers,
  sortReleases,
} from "../releases";
import { Dialog } from "./ui/dialog";

type Props = {
  seriesId: number;
  bookId: number;
  workId: string;
  title: string;
  author: string | null;
  hasPlayableAudio: boolean;
  onRefresh: () => void;
};

export function SeriesWorkReleaseSearch({
  seriesId,
  bookId,
  title,
  author,
  hasPlayableAudio,
  onRefresh,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(() =>
    author ? `${title} ${author}`.trim() : title.trim(),
  );
  const [results, setResults] = useState<AudiobookRelease[]>([]);
  const [sourceErrors, setSourceErrors] = useState<ReleaseSourceStatus[]>([]);
  const [pending, setPending] = useState(0);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [searchedQuery, setSearchedQuery] = useState("");
  const [selected, setSelected] = useState<AudiobookRelease | null>(null);
  const [queuing, setQueuing] = useState(false);
  const [selectError, setSelectError] = useState("");
  const [replaceTarget, setReplaceTarget] = useState<AudiobookRelease | null>(
    null,
  );
  const [confirmAudioTarget, setConfirmAudioTarget] =
    useState<AudiobookRelease | null>(null);
  const requestId = useRef(0);
  const busy = pending > 0;

  const search = async (page = 1, term = query) => {
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      setError("Enter at least two characters to search.");
      return;
    }
    const id = ++requestId.current;
    setError("");
    if (page === 1) {
      setResults([]);
      setNextPage(null);
      setSourceErrors([]);
      setSearchedQuery(trimmed);
    }
    setPending(1);
    try {
      const response = await api<{
        results: AudiobookRelease[];
        sourceErrors: ReleaseSourceStatus[];
        nextPage: number | null;
      }>(
        `/series/${seriesId}/works/${bookId}/releases/search?` +
          new URLSearchParams({ q: trimmed, page: String(page) }),
      );
      if (id !== requestId.current) return;
      setResults((current) =>
        page === 1
          ? response.results
          : mergeReleases(current, response.results),
      );
      setSourceErrors(response.sourceErrors);
      setNextPage(response.nextPage);
    } catch (reason) {
      if (id === requestId.current) setError((reason as Error).message);
    } finally {
      if (id === requestId.current) {
        setPending(0);
        setSearched(true);
      }
    }
  };

  const submitRelease = async (
    release: AudiobookRelease,
    options?: { replaceActive?: boolean; confirmExistingAudio?: boolean },
  ) => {
    setQueuing(true);
    setSelectError("");
    try {
      await api(`/series/${seriesId}/works/${bookId}/releases/select`, {
        method: "POST",
        body: JSON.stringify({
          source: release.source,
          id: release.id,
          ...options,
        }),
      });
      setSelected(null);
      setReplaceTarget(null);
      setConfirmAudioTarget(null);
      setOpen(false);
      onRefresh();
    } catch (reason) {
      if (reason instanceof ApiError) {
        if (reason.code === "active_download") {
          setReplaceTarget(release);
          return;
        }
        if (reason.code === "existing_audio") {
          setConfirmAudioTarget(release);
          return;
        }
      }
      setSelectError((reason as Error).message);
    } finally {
      setQueuing(false);
    }
  };

  const visible = sortReleases(
    results.filter((release) => matchesLanguage(release, "all")),
    title,
  );

  return (
    <>
      <button
        type="button"
        className="button subtle"
        onClick={() => {
          setOpen(true);
          setQuery(author ? `${title} ${author}`.trim() : title.trim());
          setError("");
          setSelectError("");
        }}
      >
        Search releases
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!queuing) {
            setOpen(next);
            if (!next) {
              requestId.current++;
              setSelected(null);
              setReplaceTarget(null);
              setConfirmAudioTarget(null);
            }
          }
        }}
        title={`Search releases · ${title}`}
        className="series-release-dialog"
      >
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void search();
          }}
        >
          <label className="search-input">
            <Search size={18} />
            <input
              aria-label="Search audiobook releases for this work"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              minLength={2}
              maxLength={150}
            />
          </label>
          <button className="button primary" disabled={busy}>
            {busy ? <Loader2 size={17} className="spin" /> : <Search size={17} />}{" "}
            Search
          </button>
        </form>
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
            <article className="release-card" key={`${release.source}-${release.id}`}>
              <div className="release-info">
                <h3>{release.title}</h3>
                <div className="release-facts">
                  <span>{release.language || "Language unknown"}</span>
                  {[release.format, release.size]
                    .filter(Boolean)
                    .map((fact, index) => (
                      <span key={index}>{fact}</span>
                    ))}
                  {!release.format && !release.size && (
                    <span>Details unavailable</span>
                  )}
                </div>
                <small className="release-source">
                  {[
                    releaseIndexers(release).join(", ") || release.source,
                    release.cached ? "Cached on TorBox" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
                <p>
                  Narrator: {release.narrator || "Not provided by this source"}
                </p>
              </div>
              <button
                type="button"
                className="button subtle"
                disabled={queuing}
                onClick={() => {
                  setSelected(release);
                  setSelectError("");
                }}
              >
                Choose
              </button>
            </article>
          ))}
        </div>
        {busy && (
          <p role="status">
            <Loader2 size={18} className="spin" /> Finding releases…
          </p>
        )}
        {searched && !busy && !visible.length && !error && (
          <p>No releases found.</p>
        )}
        {nextPage && (
          <button
            type="button"
            className="button subtle"
            disabled={busy}
            onClick={() => void search(nextPage, searchedQuery)}
          >
            Load more releases
          </button>
        )}
        <Dialog
          open={!!selected}
          onOpenChange={(next) => {
            if (!queuing && !next) setSelected(null);
          }}
          title="Use this release"
          className="release-dialog"
        >
          {selected && (
            <>
              <h2>{selected.title}</h2>
              <p>
                Narrator: {selected.narrator || "Not provided by this source"}
              </p>
              {hasPlayableAudio && (
                <p>
                  This work already has playable audio. The existing recording
                  stays until you remove it.
                </p>
              )}
              {selectError && (
                <p className="inline-error" role="alert">
                  {selectError}
                </p>
              )}
              <button
                type="button"
                className="button primary"
                disabled={queuing}
                onClick={() => void submitRelease(selected)}
              >
                {queuing ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  "Download this release"
                )}
              </button>
            </>
          )}
        </Dialog>
      </Dialog>
      <Dialog
        open={!!replaceTarget}
        onOpenChange={(next) => {
          if (!queuing && !next) setReplaceTarget(null);
        }}
        title="Replace active download?"
      >
        {replaceTarget && (
          <>
            <p>
              A download is already in progress for this work. Replace it with{" "}
              {replaceTarget.title} or cancel your new selection.
            </p>
            <button
              type="button"
              className="button primary"
              disabled={queuing}
              onClick={() =>
                void submitRelease(replaceTarget, { replaceActive: true })
              }
            >
              Replace download
            </button>
            <button
              type="button"
              className="button subtle"
              disabled={queuing}
              onClick={() => setReplaceTarget(null)}
            >
              Cancel
            </button>
          </>
        )}
      </Dialog>
      <Dialog
        open={!!confirmAudioTarget}
        onOpenChange={(next) => {
          if (!queuing && !next) setConfirmAudioTarget(null);
        }}
        title="Download another release?"
      >
        {confirmAudioTarget && (
          <>
            <p>
              This work already has playable audio. Downloading{" "}
              {confirmAudioTarget.title} adds another release; your existing
              audio stays until you remove it.
            </p>
            <button
              type="button"
              className="button primary"
              disabled={queuing}
              onClick={() =>
                void submitRelease(confirmAudioTarget, {
                  confirmExistingAudio: true,
                })
              }
            >
              Download anyway
            </button>
            <button
              type="button"
              className="button subtle"
              disabled={queuing}
              onClick={() => setConfirmAudioTarget(null)}
            >
              Cancel
            </button>
          </>
        )}
      </Dialog>
    </>
  );
}
