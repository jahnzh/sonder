// Discover's series search (#470 keeps its look until Discover's slice): "View series" opens the Series page,
// `#series/<id>`. The series dialog this file held went with #569; the page, its Add sheet and Remove series replace it.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../lib";
import "../series.css";

type SeriesSummary = { id: number; name: string; author: string | null; count: number | null; cover?: string | null };

/** The Library's "Find a series" (#567) asked for the series search: Discover shown next puts its field in view, focused. */
let seriesSearchAsked = false;
export function askSeriesSearch() {
  seriesSearchAsked = true;
}
/** Discover opens on its series search while the ask is pending. */
export function seriesSearchWanted() {
  return seriesSearchAsked;
}

export function SeriesDiscovery({ configured, onConnect, onOpen }: { configured: boolean; onConnect: () => void; onOpen: (id: number) => void }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!seriesSearchAsked) return;
    seriesSearchAsked = false;
    field.current?.scrollIntoView({ block: "center" });
    field.current?.focus({ preventScroll: true });
  }, []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SeriesSummary[]>([]);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const search = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(""); setSearched(true);
    try { setResults(await api<SeriesSummary[]>(`/discover/series?q=${encodeURIComponent(query.trim())}`)); }
    catch (error) { setResults([]); setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="external-search series-search">
    <div className="section-heading"><h2>Search series</h2></div>
    {!configured && <p>Connect Hardcover to search for series. <button className="button subtle" onClick={onConnect}>Connect Hardcover</button></p>}
    <form onSubmit={(event) => void search(event)}>
      <label className="search-input"><input ref={field} aria-label="Search series" placeholder="Series name" value={query} onChange={(event) => setQuery(event.target.value)} minLength={2} required /></label>
      <button className="button primary" disabled={busy || !configured}>Search series</button>
    </form>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {searched && !busy && !error && !results.length && <p>No series found.</p>}
    <div className="series-results">{results.map((item) => <article className="series-result" key={item.id}>
      {item.cover && <img src={item.cover} alt="" />}
      <div><strong>{item.name}</strong><p>{item.author || "Author unknown"}{item.count !== null ? ` · ${item.count} works` : ""}</p><small>Hardcover #{item.id}</small></div>
      <button className="button subtle" aria-label={`View ${item.name} by ${item.author || "unknown author"}`} onClick={() => onOpen(item.id)}>View series</button>
    </article>)}</div>
  </section>;
}
