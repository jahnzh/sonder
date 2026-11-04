import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib";
import type { Download } from "../types";
import { Dialog } from "./ui/dialog";
import "../series.css";

type SeriesSummary = { id: number; name: string; author: string | null; count: number | null; cover?: string | null };
type SeriesWork = {
  id: number; title: string; position: number | null; cover: string | null;
  workId: string | null; owned?: boolean; selected?: boolean; unreleased: boolean;
  needsAdmin?: boolean;
  added?: boolean; finished?: boolean; new?: boolean;
  availability?: { audio: { server: boolean | null; recordings: { id: string; tracks: string[]; server: boolean; stream: boolean }[] }; ebook: { server: boolean | null; device: null } };
};
type Series = SeriesSummary & {
  works: SeriesWork[];
  needsAdmin?: { id: number; title: string }[];
  completion?: { finished: number; total: number; nextBookId: number | null };
  refreshError?: string;
};
export type SeriesTarget = { id: number; mode: "preview" | "saved" };

export function SeriesDiscovery({ configured, onConnect, onOpen }: { configured: boolean; onConnect: () => void; onOpen: (id: number) => void }) {
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
      <label className="search-input"><input aria-label="Search series" placeholder="Series name" value={query} onChange={(event) => setQuery(event.target.value)} minLength={2} required /></label>
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

export function SeriesLibrary({ onOpen, revision }: { onOpen: (id: number) => void; revision: number }) {
  const [items, setItems] = useState<SeriesSummary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { let active = true; api<SeriesSummary[]>("/series").then((value) => { if (active) setItems(value); }).catch((reason) => { if (active) setError(reason.message); }); return () => { active = false; }; }, [revision]);
  return <section className="library-section series-library"><div className="section-heading"><h2>Series</h2></div>
    {error ? <p className="inline-error">{error}</p> : !items.length ? <p>No saved series yet. Search for a series in Discover.</p> :
      <div className="series-results">{items.map((item) => <article className="series-result" key={item.id}>
        <div><strong>{item.name}</strong><p>{item.author || "Author unknown"} · Hardcover #{item.id}</p></div>
        <button className="button subtle" aria-label={`Open ${item.name} by ${item.author || "unknown author"}`} onClick={() => onOpen(item.id)}>Open series</button>
      </article>)}</div>}
  </section>;
}

export function SeriesDialog({ target, onClose, onSaved, downloads }: { target: SeriesTarget | null; onClose: () => void; onSaved: () => void; downloads: Download[] }) {
  const [series, setSeries] = useState<Series | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [mode, setMode] = useState<"preview" | "saved">("preview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  useEffect(() => {
    if (!target) return;
    let active = true;
    setSeries(null); setError(""); setMode(target.mode); setSavedNotice(false); setSelected([]);
    void api<Series>(target.mode === "saved" ? `/series/${target.id}` : `/hardcover/series/${target.id}`).then((value) => {
      if (!active) return;
      setSeries(value);
      setSelected(target.mode === "preview"
        ? value.works.filter((work) => work.selected).map((work) => work.id)
        : []);
    }).catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [target]);
  const save = async () => {
    if (!series || !selected.length) return;
    setBusy(true); setError("");
    try {
      const result = await api<Series>("/series", { method: "POST", body: JSON.stringify({ id: series.id, bookIds: selected }) });
      setSeries(result); setMode("saved"); setSelected([]); setSavedNotice(true); onSaved();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  const next = series?.works.find((work) => work.id === series.completion?.nextBookId);
  const numbered = series?.works.filter((work) => work.position !== null) || [];
  const unnumbered = series?.works.filter((work) => work.position === null) || [];
  const canSelect = (work: SeriesWork) => mode === "preview" || (mode === "saved" && !work.added);
  const renderWorks = (works: SeriesWork[]) => works.map((work) => {
    const audio = work.availability?.audio;
    const device = audio?.recordings.some((recording) => recording.tracks.length > 0 && recording.tracks.every((id) => downloads.some((download) => download.trackId === id)));
    const selectable = canSelect(work);
    return <li className={`series-work${work.new ? " series-work-new" : ""}`} key={work.id}>
      {selectable ? <label><input type="checkbox" disabled={work.needsAdmin} checked={selected.includes(work.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, work.id] : current.filter((id) => id !== work.id))} />
        <span>{work.position !== null && <b>#{work.position} </b>}{work.title}</span></label> : <strong>{work.position !== null && `#${work.position} `}{work.title}</strong>}
      <div className="series-work-meta">
        {work.new && <span>New</span>}
        {work.owned && mode === "preview" && <span>Already in your library</span>}
        {work.needsAdmin && selectable && <span>Possible existing match: ask an administrator to confirm and link it.</span>}
        {work.unreleased && <span>Unreleased</span>}
        {mode === "saved" && <>
          <span>{work.added ? "In your series selection" : "Not added"}{work.finished ? " · Finished" : ""}</span>
          <span>Audio: {audio?.server == null ? "availability unknown" : audio.server ? "on server" : "not on server"}{work.workId ? (device ? " · on device" : " · not on device") : ""}{audio?.recordings.some((recording) => recording.stream) ? " · stream availability unknown" : ""}</span>
          <span>Ebook: {work.availability?.ebook.server == null ? "availability unknown" : work.availability.ebook.server ? "on server" : "not on server"} · device availability unknown</span>
        </>}
      </div>
    </li>;
  });
  return <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }} title={series?.name || "Series"} className="series-dialog">
    {error && <p className="inline-error" role="alert">{error}</p>}
    {series?.refreshError && <p className="inline-error" role="alert">Could not refresh from Hardcover. Showing the last saved catalogue. {series.refreshError}</p>}
    {!series && !error && <p>Loading series…</p>}
    {series && <>
      {savedNotice && <p role="status">Series saved.</p>}
      {!!series.needsAdmin?.length && <p>These works need an administrator to confirm and link an existing match: {series.needsAdmin.map((work) => work.title).join(", ")}.</p>}
      <p>{series.author || "Author unknown"} · <span>Hardcover #{series.id}</span></p>
      {mode === "saved" && series.completion && <p>{series.completion.finished} of {series.completion.total} works finished · {next ? `Next unfinished: ${next.title}` : "Series complete"}</p>}
      {numbered.length > 0 && <><h3>Numbered works</h3><ol className="series-works">{renderWorks(numbered)}</ol></>}
      {unnumbered.length > 0 && <><h3>Related works</h3><ul className="series-works">{renderWorks(unnumbered)}</ul></>}
      {mode === "preview" || selected.length > 0
        ? <button className="button primary" disabled={busy || !selected.length} onClick={() => void save()}>Add selected works</button>
        : <button className="button subtle" onClick={onClose}>Close series</button>}
      {mode === "saved" && selected.length > 0 && <button className="button subtle" onClick={onClose}>Close series</button>}
    </>}
  </Dialog>;
}
