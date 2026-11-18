import { useState, type FormEvent } from "react";
import {
  Compass,
  Search,
  Plus,
  ArrowUpRight,
  ArrowRight,
  Check,
  BookOpen,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { ReleasePicker } from "../components/ReleasePicker";
import { SeriesDiscovery } from "../components/Series";
import { hardcoverChanged } from "../components/Hardcover";
import { EbookDiscovery } from "../components/SourceWorkflow";
import { api, duration } from "../lib";
import type { Book, Settings as SettingsData } from "../types";
import { Empty } from "./shared";
export function DiscoverPage({
  admin,
  settings,
  onQueued,
  books,
  query,
  onQuery,
  onDetail,
  onAdd,
  notify,
  torboxConfigured,
  onConnect,
  onSeries,
  refresh,
}: {
  admin: boolean;
  settings: SettingsData | null;
  onQueued: () => void;
  books: Book[];
  query: string;
  onQuery: (q: string) => void;
  onDetail: (b: Book) => void;
  onAdd: (b: Book) => void;
  notify: (text: string, error?: boolean) => void;
  torboxConfigured: boolean;
  onConnect: () => void;
  onSeries: (id: number) => void;
  refresh: () => Promise<void>;
}) {
  const [genre, setGenre] = useState("All genres");
  const [source, setSource] = useState<
    "curated" | "abb" | "hardcover" | "ebooks" | "series"
  >("curated");
  const [busy, setBusy] = useState(false);
  const [external, setExternal] = useState<
    {
      id: string;
      title: string;
      author: string;
      cover?: string;
      description?: string;
      genre?: string;
      url?: string;
    }[]
  >([]);
  const [error, setError] = useState("");
  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (query.trim().length < 2) {
      setError("Enter at least two characters to search.");
      return;
    }
    setBusy(true);
    setError("");
    setExternal([]);
    try {
      if (source === "abb")
        setExternal(await api("/discover/abb?q=" + encodeURIComponent(query)));
      else {
        const result = await api<
          | {
              hits?: {
                document: {
                  id: string;
                  title: string;
                  author_names?: string[];
                  image?: { url: string };
                  description?: string;
                  url?: string;
                };
              }[];
            }
          | string
        >("/discover/hardcover?q=" + encodeURIComponent(query));
        const data = typeof result === "string" ? JSON.parse(result) : result;
        setExternal(
          (data.hits || []).map(
            (h: {
              document: {
                id: string;
                title: string;
                author_names?: string[];
                image?: { url: string };
                description?: string;
                url?: string;
              };
            }) => ({
              ...h.document,
              author: h.document.author_names?.join(", ") || "Unknown author",
              cover: h.document.image?.url,
              url: h.document.url,
            }),
          ),
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addCatalog = async (id: string) => {
    setBusy(true);
    try {
      await api("/hardcover/books", {
        method: "POST",
        body: JSON.stringify({ id: Number(id) }),
      });
      hardcoverChanged();
      await refresh();
      notify(
        "Added to your library. Match or find audio whenever you’re ready.",
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const visible = books
    .filter((b) => admin ? b.sourceLabel.startsWith("LibriVox") : !b.inLibrary)
    .filter((b) => genre === "All genres" || b.genre === genre);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Discover</h1>
        </div>
      </div>
      <div className="discovery-sources">
        <button
          className={source === "curated" ? "selected" : ""}
          onClick={() => {
            setSource("curated");
            setError("");
          }}
        >
          Classics
        </button>
        {admin && (
        <button
          className={source === "abb" ? "selected" : ""}
          onClick={() => {
            setSource("abb");
            setError("");
            setExternal([]);
          }}
        >
          Audiobooks <ArrowUpRight size={13} />
        </button>
        )}
        <button
          className={source === "hardcover" ? "selected" : ""}
          onClick={() => {
            setSource("hardcover");
            setError("");
            setExternal([]);
          }}
        >
          Hardcover <ArrowUpRight size={13} />
        </button>
        <button className={source === "series" ? "selected" : ""} onClick={() => { setSource("series"); setError(""); }}>Series</button>
        {admin && (
        <button
          className={source === "ebooks" ? "selected" : ""}
          onClick={() => {
            setSource("ebooks");
            setError("");
          }}
        >
          Ebooks <BookOpen size={13} />
        </button>
        )}
      </div>
      {source === "series" ? (
        <SeriesDiscovery configured={!!settings?.hardcoverConfigured} onConnect={onConnect} onOpen={onSeries} />
      ) : source === "ebooks" ? (
        <EbookDiscovery
          query={query}
          onQuery={onQuery}
          settings={settings}
          notify={notify}
        />
      ) : source === "abb" ? (
        <ReleasePicker
          query={query}
          onQuery={onQuery}
          prowlarrConfigured={!!settings?.prowlarrConfigured}
          onQueued={onQueued}
          refresh={refresh}
          notify={notify}
        />
      ) : source === "curated" ? (
        <section id="discover-books">
          <div className="section-heading">
            <h2>{admin ? "Classics" : "Shared catalogue"}</h2>
            <span className="muted small">
              Public-domain recordings · LibriVox
            </span>
          </div>
          <div className="genre-chips">
            {[
              "All genres",
              "Fiction",
              "Fantasy",
              "Mystery",
              "Science fiction",
              "Mind & life",
            ].map((g) => (
              <button
                key={g}
                className={genre === g ? "selected" : ""}
                onClick={() => setGenre(g)}
              >
                {g}
              </button>
            ))}
          </div>
          {visible.length ? (
            <div className="books-grid discover-grid">
              {visible.map((b) => (
                <article className="discover-book" key={b.id}>
                  <button className="book-cover" onClick={() => onDetail(b)}>
                    <img src={b.cover} alt={b.title} />
                  </button>
                  <span className="discovery-genre">{b.genre}</span>
                  <button className="book-title" onClick={() => onDetail(b)}>
                    {b.title}
                  </button>
                  <p className="book-author">{b.author}</p>
                  <div className="discovery-book-footer">
                    <span>{duration(b.duration)}</span>
                    <button
                      onClick={() => (b.inLibrary ? onDetail(b) : onAdd(b))}
                      className={b.inLibrary ? "saved" : ""}
                      aria-label={
                        b.inLibrary
                          ? `View ${b.title}`
                          : `Add ${b.title} to library`
                      }
                    >
                      {b.inLibrary ? <Check size={16} /> : <Plus size={18} />}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              icon={Search}
              title="Try a different trail"
              text="No books match this search and genre. Try another title or choose All genres."
            />
          )}
          {admin && (
          <div className="discover-ebook-callout">
            <div>
              <BookOpen size={23} />
              <span>
                <strong>Prefer turning pages?</strong>
                <p>
                  Find ebook editions on Library Genesis.
                </p>
              </span>
            </div>
            <button
              className="button subtle"
              onClick={() => setSource("ebooks")}
            >
              Explore ebooks <ArrowRight size={14} />
            </button>
          </div>
          )}
        </section>
      ) : (
        <section className="external-search">
          <div className="section-heading">
            <h2>Search Hardcover</h2>
          </div>
          {!settings?.hardcoverConfigured && <p>Add your Hardcover token in Settings to search books.</p>}
          <form onSubmit={(e) => void search(e)}>
            <label className="search-input">
              <Search size={18} />
              <input
                aria-label="Search Hardcover"
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                placeholder="Book title or author"
                minLength={2}
              />
            </label>
            <button className="button primary" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={17} />
              ) : (
                <Search size={17} />
              )}{" "}
              Search
            </button>
          </form>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {busy && !external.length ? (
            <div className="external-loading">
              <Loader2 className="spin" /> Searching…
            </div>
          ) : external.length ? (
            <div className="external-results">
              {external.map((b) => (
                <article key={b.id}>
                  <img
                    src={b.cover || "/covers/time.svg"}
                    alt=""
                    onError={(e) => {
                      e.currentTarget.src = "/covers/time.svg";
                    }}
                  />
                  <div>
                    <h3>{b.title}</h3>
                    <p>{b.author}</p>
                    {b.description && (
                      <small>{b.description.slice(0, 180)}</small>
                    )}
                  </div>
                  <div className="discovery-actions">
                    {b.url && (
                      <a
                        className="button subtle"
                        href={b.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View book <ExternalLink size={14} />
                      </a>
                    )}
                    <button
                      className="button subtle"
                      disabled={busy}
                      onClick={() => void addCatalog(b.id)}
                    >
                      <Plus size={15} /> Add to library
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            !error && (
              <Empty
                icon={Compass}
                title="Search books"
                text="Enter a book title or author."
              />
            )
          )}
        </section>
      )}
    </>
  );
}
