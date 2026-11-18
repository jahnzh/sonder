import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import {
  BookOpen,
  ExternalLink,
  HardDrive,
  Loader2,
  Search,
  Check,
  Upload,
} from "lucide-react";
import { api, localDB } from "../lib";
import type {
  EbookResult,
  SavedEbook,
  Settings,
} from "../types";
type Notify = (message: string, error?: boolean) => void;
export function EbookDiscovery({
  query,
  onQuery,
  settings,
  notify,
}: {
  query: string;
  onQuery: (q: string) => void;
  settings: Settings | null;
  notify: Notify;
}) {
  // Discover's ebook search without a book (#572 removes it). A book's ebook is got in its Get ebook sheet (#604).
  const source = "libgen";
  const [results, setResults] = useState<EbookResult[]>([]);
  const [saved, setSaved] = useState<SavedEbook[]>([]);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const [importing, setImporting] = useState(false);
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
      const response = await api<{ alreadySaved: boolean }>("/ebooks/import", { method: "POST", body });
      await refreshSaved();
      // The ebook's book is in the importer's library now (#555): the Library reads it again (#556).
      window.dispatchEvent(new Event("sonder:library-changed"));
      notify(
        response.alreadySaved
          ? "This ebook is already on your server."
          : "Your ebook is saved on the 4 TB media drive.",
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
      await api("/ebooks", { method: "POST", body: JSON.stringify(book) });
      notify("Your ebook is saved on the 4 TB media drive.");
      window.dispatchEvent(new Event("sonder:library-changed"));
      await refreshSaved();
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
        Find EPUB and PDF editions through Library Genesis. Save an edition to your server to read or download it.
      </p>
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
          your server.
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
