import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  BookOpen,
  Cloud,
  ExternalLink,
  HardDrive,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  ArrowRight,
  Check,
  Upload,
} from "lucide-react";
import { api, bytes, localDB } from "../lib";
import {
  TorrentHealthLine,
  useTorrentHealth,
} from "./TorrentHealth";
import {
  EBOOK_SET_PENDING_REFRESH_MS,
  checkingNote,
  ebookSetHasPendingMember,
  ebookSetStatusLabel,
  type EbookSetMember,
  type EbookSetView,
} from "../ebook-set";
import type {
  Acquisition,
  EbookResult,
  SavedEbook,
  Settings,
  Book,
} from "../types";
type Notify = (message: string, error?: boolean) => void;
export function AcquisitionQueue({
  onReady,
  onOpenBook,
  onBrowse,
  notify,
}: {
  onReady: () => void;
  onOpenBook: (id: string) => void;
  onBrowse: () => void;
  notify: Notify;
}) {
  const [jobs, setJobs] = useState<Acquisition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const readyIds = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    try {
      const next = await api<Acquisition[]>("/acquisitions");
      setJobs(next.sort((a, b) => b.createdAt - a.createdAt));
      setError("");
      await localDB.preferences.put({ key: "server-queue", value: next });
      const ready = next.filter((j) => j.status === "ready");
      if (ready.some((j) => !readyIds.current.has(j.id))) {
        readyIds.current = new Set(ready.map((j) => j.id));
        onReady();
      }
    } catch (e) {
      if (navigator.onLine) setError((e as Error).message);
      else {
        const cached = await localDB.preferences.get("server-queue");
        if (Array.isArray(cached?.value)) setJobs(cached.value);
      }
    } finally {
      setLoading(false);
    }
  }, [onReady]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (navigator.onLine) void refresh();
    }, 6000);
    return () => clearInterval(timer);
  }, [refresh]);
  const control = async (
    job: Acquisition,
    action: "pause" | "resume" | "retry",
  ) => {
    setBusy(job.id);
    try {
      await api(`/acquisitions/${job.id}/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="server-queue">
      <div className="section-heading">
        <div>
          <h2>
            On your home server <span>{jobs.length}</span>
          </h2>
          <p className="queue-location">
            <HardDrive size={14} /> 4 TB media drive · Downloads keep going when
            you leave.
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh server downloads"
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="source-explainer">
        <ShieldCheck size={19} />
        <span>
          Cached on TorBox? Stream it. Otherwise, your server downloads the book
          to the HDD. Once it’s ready, you can listen or save a copy on this
          device.
        </span>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="external-loading">
          <Loader2 className="spin" /> Loading downloads…
        </div>
      ) : jobs.length ? (
        <div className="download-list">
          {jobs.map((job) => (
            <article className="download-row" key={job.id}>
              <div className="download-cover">
                <img
                  src={job.cover}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.src = "/covers/time.svg";
                  }}
                />
              </div>
              <div className="download-info">
                <button
                  className="text-link"
                  disabled={!job.bookId}
                  onClick={() => job.bookId && onOpenBook(job.bookId)}
                >
                  {job.title}
                </button>
                <p>{job.author}</p>
                {!["ready", "error"].includes(job.status) && (
                  <div className="queue-progress">
                    <i
                      style={{ width: `${Math.round(job.progress * 100)}%` }}
                    />
                  </div>
                )}
                <div className={`queue-info ${job.error ? "queue-error" : ""}`}>
                  {job.error ||
                    {
                      checking: "Checking the fastest source…",
                      preparing: "Preparing your cached stream…",
                      downloading: `Downloading to your server · ${Math.round(job.progress * 100)}%`,
                      paused: `Paused · ${Math.round(job.progress * 100)}% downloaded`,
                      ready:
                        job.backend !== "torbox"
                          ? "Ready to listen · Stored on the HDD"
                          : "Ready to stream · Cached on TorBox",
                      error: "Download failed. Retry to continue.",
                    }[job.status]}
                </div>
              </div>
              <div className="download-actions">
                <span className="queue-badge">
                  {job.backend !== "torbox" ? (
                    <>
                      <HardDrive size={11} /> Your server
                    </>
                  ) : (
                    <>
                      <Cloud size={11} /> TorBox cache
                    </>
                  )}
                </span>
                {job.status === "ready" ? (
                  <button
                    className="button subtle"
                    onClick={() => job.bookId && onOpenBook(job.bookId)}
                  >
                    <Play size={13} /> Open book
                  </button>
                ) : (
                  <button
                    className="button subtle"
                    disabled={
                      busy === job.id ||
                      ["checking", "preparing"].includes(job.status)
                    }
                    onClick={() =>
                      void control(
                        job,
                        job.status === "error"
                          ? "retry"
                          : job.status === "paused"
                            ? "resume"
                            : "pause",
                      )
                    }
                  >
                    {busy === job.id ? (
                      <Loader2 className="spin" size={13} />
                    ) : job.status === "error" ? (
                      <RefreshCw size={13} />
                    ) : job.status === "paused" ? (
                      <Play size={13} />
                    ) : (
                      <Pause size={13} />
                    )}{" "}
                    {job.status === "error"
                      ? "Retry"
                      : job.status === "paused"
                        ? "Resume"
                        : "Pause"}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="queue-empty">
          <button onClick={onBrowse}>Browse audiobooks</button> or add a magnet
          link to start a server download.
        </div>
      )}
    </section>
  );
}
export function EbookDiscovery({
  query,
  onQuery,
  settings,
  notify,
  target,
}: {
  query: string;
  onQuery: (q: string) => void;
  settings: Settings | null;
  notify: Notify;
  target?: Book | null;
}) {
  const source = "libgen";
  const [results, setResults] = useState<EbookResult[]>([]);
  const [saved, setSaved] = useState<SavedEbook[]>([]);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const [importing, setImporting] = useState(false);
  const [setMembers, setSetMembers] = useState<EbookSetMember[]>([]);
  const refreshSet = useCallback(async () => {
    if (!target?.workId) {
      setSetMembers([]);
      return;
    }
    try {
      setSetMembers(
        (await api<EbookSetView>(
          `/works/${encodeURIComponent(target.workId)}/ebook-set`,
        )).members,
      );
    } catch {
      setSetMembers([]);
    }
  }, [target?.workId]);
  const refreshSaved = useCallback(async () => {
    try {
      const books = await api<SavedEbook[]>("/ebooks");
      setSaved(books);
      await localDB.preferences.put({ key: "ebooks", value: books });
    } catch {
      const cache = await localDB.preferences.get("ebooks");
      if (Array.isArray(cache?.value)) setSaved(cache.value);
    }
  }, []);
  useEffect(() => {
    void refreshSaved();
  }, [refreshSaved]);
  useEffect(() => {
    void refreshSet();
  }, [refreshSet]);
  const checking = ebookSetHasPendingMember(setMembers);
  useEffect(() => {
    if (!checking) return;
    const timer = window.setInterval(() => void refreshSet(), EBOOK_SET_PENDING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [checking, refreshSet]);
  const base = settings?.libgenUrl || "https://libgen.li";
  const website = `${base}/index.php?req=${encodeURIComponent(query)}`;
  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (query.trim().length < 2) {
      setError("Enter a title or author with at least two characters.");
      return;
    }
    setBusy(true);
    setError("");
    setSearched(true);
    setResults([]);
    try {
      const response = await api<{ files: EbookResult[]; website: string }>(
        "/discover/ebooks?" + new URLSearchParams({ source, q: query }),
      );
      setResults(response.files);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const uploadEbook = async (file: File) => {
    setImporting(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await api<{ alreadySaved: boolean; ebookSet?: { status: EbookSetMember["status"] } }>(
        "/ebooks/import" +
          (target ? `?workId=${encodeURIComponent(target.workId)}` : ""),
        { method: "POST", body },
      );
      await refreshSaved();
      await refreshSet();
      // The ebook's book is in the importer's library now (#555): the Library reads it again (#556).
      window.dispatchEvent(new Event("sonder:library-changed"));
      notify(
        (response.alreadySaved
          ? "This ebook is already on your server."
          : "Your ebook is saved on the 4 TB media drive.") + checkingNote(response.ebookSet),
      );
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setImporting(false);
    }
  };
  const download = async (book: EbookResult) => {
    setDownloading(book.md5);
    try {
      const response = await api<{ ebookSet?: { status: EbookSetMember["status"] } }>("/ebooks", {
        method: "POST",
        body: JSON.stringify({
          ...book,
          ...(target ? { workId: target.workId } : {}),
        }),
      });
      notify("Your ebook is saved on the 4 TB media drive." + checkingNote(response.ebookSet));
      window.dispatchEvent(new Event("sonder:library-changed"));
      await refreshSaved();
      await refreshSet();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setDownloading(null);
    }
  };
  return (
    <section className="ebook-discovery">
      <div className="section-heading">
        <h2>Ebooks</h2>
        <span className="quiet-tag">
          <BookOpen size={14} /> Ebooks
        </span>
      </div>
      <p className="ebook-source-note">
        Find EPUB and PDF editions through Library Genesis.{" "}
        {target
          ? `Downloaded editions will be linked to “${target.title}”.`
          : "Save an edition to your server to read or download it."}
      </p>
      {target && setMembers.length > 0 && (
        <ul className="ebook-set-members" aria-label="Ebook set members">
          {setMembers.map((member) => (
            <li key={member.ebookId}>
              <strong>{member.sourceTitle || member.ebookId}</strong>
              <span>{ebookSetStatusLabel(member.status)}</span>
              {member.language && <span>{member.language}</span>}
              {member.byteSize != null && <span>{bytes(member.byteSize)}</span>}
              <span>
                Shared {member.evidence.sharedSentenceCount}, unique{" "}
                {member.evidence.uniqueSentenceCount}
              </span>
              {member.evidence.audioSupportedCoverage != null && (
                <span>
                  Audio coverage{" "}
                  {Math.round(member.evidence.audioSupportedCoverage * 100)}%
                </span>
              )}
              {!member.evidence.outlier.passed &&
                member.evidence.outlier.samples[0]?.passage && (
                  <span>{member.evidence.outlier.samples[0].passage}</span>
                )}
            </li>
          ))}
        </ul>
      )}
      <form className="ebooks-search-form" onSubmit={(e) => void search(e)}>
        <input
          className="ebook-search-query"
          aria-label="Search ebook title or author"
          placeholder="A title or an author…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          minLength={2}
        />
        <button className="button primary" disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <Search size={16} />}{" "}
          Search
        </button>
      </form>
      <a
        className="source-link"
        href={website}
        target="_blank"
        rel="noreferrer"
      >
        Search on Library Genesis{" "}
        <ExternalLink size={12} />
      </a>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {busy ? (
        <div className="external-loading">
          <Loader2 className="spin" /> Turning a few pages…
        </div>
      ) : (
        <div className="ebook-list">
          {results.map((book) => {
            const stored = saved.some(
              (s) => s.id === `${book.source}-${book.md5}`,
            );
            return (
              <article className="ebook-result" key={book.md5}>
                <img
                  src={book.coverUrl || "/covers/meditations.svg"}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.src = "/covers/meditations.svg";
                  }}
                />
                <div className="ebook-result-info">
                  <h3>{book.title}</h3>
                  <p>{book.authors.join(", ") || "Unknown author"}</p>
                  <div className="ebook-facts">
                    <span>{book.extension.toUpperCase()}</span>
                    {book.language && <span>· {book.language}</span>}
                    {book.size && <span>· {book.size}</span>}
                    {book.year && <span>· {book.year}</span>}
                  </div>
                </div>
                <div className="ebook-actions">
                  <a
                    className="button subtle"
                    href={book.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Source <ExternalLink size={12} />
                  </a>
                  <button
                    className="button subtle"
                    disabled={!!downloading || stored}
                    onClick={() => void download(book)}
                  >
                    {downloading === book.md5 ? (
                      <Loader2 size={14} className="spin" />
                    ) : stored ? (
                      <Check size={14} />
                    ) : (
                      <HardDrive size={14} />
                    )}{" "}
                    {stored ? "On your server" : "Save to server"}
                  </button>
                </div>
              </article>
            );
          })}
          {searched && !results.length && !error && (
            <div className="queue-empty">
              No EPUB or PDF editions found. Try the title alone, or search the
              source website.
            </div>
          )}
        </div>
      )}
      <div className="ebook-import">
        <p>
          Downloaded a book in your browser? Import an EPUB or PDF to keep it on
          your server{target ? ` with “${target.title}”` : ""}.
        </p>
        <label className={`button subtle ${importing ? "disabled" : ""}`}>
          {importing ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Upload size={15} />
          )}{" "}
          {importing ? "Importing…" : "Import ebook"}
          <input
            type="file"
            accept=".epub,.pdf,application/epub+zip,application/pdf"
            aria-label="Import ebook"
            disabled={importing}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadEbook(file);
              event.target.value = "";
            }}
          />
        </label>
      </div>
    </section>
  );
}
export function SourceSettings({
  settings,
  onSaved,
  notify,
}: {
  settings: Settings | null;
  onSaved: () => void;
  notify: Notify;
}) {
  const [libgenUrl, setLibgenUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (settings) {
      setLibgenUrl(settings.libgenUrl);
    }
  }, [settings]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ libgenUrl }),
      });
      onSaved();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const torrentHealth = useTorrentHealth();
  const testLocal = async () => {
    setTesting(true);
    try {
      await api("/local/test", { method: "POST" });
      const health = await torrentHealth.check(true);
      if (health && health.status !== "ok") notify(health.message, true);
      else
        notify(
          "Your local torrent client is connected. Audio stays on the 4 TB drive.",
        );
    } catch (e) {
      void torrentHealth.check(true);
      notify((e as Error).message, true);
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <section className="settings-section">
        <div className="settings-section-heading">
          <span className="settings-section-icon green">
            <HardDrive size={20} />
          </span>
          <div>
            <h2>Your home server</h2>
            <p>Uncached audiobooks download to the 4 TB media drive.</p>
          </div>
          <span
            className={`connection-tag ${settings?.localConfigured ? "connected" : ""}`}
          >
            <span />
            {settings?.localConfigured ? "Configured" : "Not configured"}
          </span>
        </div>
        <div className="source-explainer">
          <ShieldCheck size={18} />
          <span>
            TorBox is used for cached books. Everything else downloads through
            your local torrent client. Both incomplete and finished audio stay
            on the HDD. Server downloads continue when you close Sonder.
          </span>
        </div>
        <TorrentHealthLine
          health={torrentHealth.health}
          checking={torrentHealth.checking}
        />
        <button
          className="button subtle"
          onClick={() => void testLocal()}
          disabled={testing || !settings?.localConfigured}
        >
          {testing ? (
            <Loader2 className="spin" size={15} />
          ) : (
            <RefreshCw size={15} />
          )}{" "}
          Test local connection
        </button>
      </section>
      <form
        onSubmit={(e) => void save(e)}
        className="settings-form ebook-settings-form"
      >
        <section className="settings-section">
          <div className="settings-section-heading">
            <span className="settings-section-icon">
              <BookOpen size={20} />
            </span>
            <div>
              <h2>Library Genesis</h2>
              <p>Find and save EPUB and PDF editions. No key required.</p>
            </div>
          </div>
          <label>
            Mirror URL
            <input
              type="url"
              value={libgenUrl}
              onChange={(e) => setLibgenUrl(e.target.value)}
              required
              placeholder="https://libgen.li"
            />
            <small>
              Some mirrors require browser verification. The discovery view also
              links to the source website.
            </small>
          </label>
        </section>
        <div className="settings-save">
          <span>
            <HardDrive size={15} /> Ebooks are stored on the 4 TB media drive.
          </span>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Check size={15} />
            )}{" "}
            Save ebook sources
          </button>
        </div>
      </form>
    </>
  );
}
