// The book's Edit page (#719 part a): `#book/<workId>/edit`, the administrator's, reached from the Book page and built
// like the match page (#721). Groups of fields (Details, Series, Narrators per recording, Cover, About), each edited
// field marked Edited with the source's value under it and its own Revert; Save sends the changed fields. Edits are
// kept in Sonder only. Anyone else is told the administrator edits. Words and steps: src/pages/edit-page-model.ts.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../lib";
import { PageHeader } from "../parts/PageHeader";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { Button } from "../parts/Button";
import { Switch } from "../parts/Switch";
import type { SeriesEntry, WorkField, WorkMetadata } from "../types";
import { SEARCH_PROVIDERS, PROVIDER_NAMES, type CatalogueSearch } from "../catalogue-page-model";
import {
  ADD_SERIES,
  ADMIN_EDITS_LINE,
  COVER_ADDRESS_LABEL,
  EDITED,
  EDIT_TITLE,
  FIELD_LABELS,
  FIND_COVERS,
  LOCAL_SERIES_LABEL,
  NOTHING_TO_SAVE,
  NO_COVERS,
  POSITION_LABEL,
  REMOVE,
  REVERT,
  SAVE,
  SAVED,
  SAVING,
  SERIES_SEARCH_LABEL,
  TEXT_FIELDS,
  UPLOAD_COVER,
  changedFields,
  draftOf,
  draftProblem,
  isEdited,
  joinList,
  seriesEntry,
  seriesLabel,
  sourceText,
  splitList,
  type Draft,
} from "./edit-page-model";
import "./settings/settings.css";
import "./match-page.css";
import "./edit-page.css";

type Props = { workId: string; admin: boolean; onChanged: () => void };
type Line = { text: string; failed: boolean } | null;
type FoundSeries = { id: string; name: string; author: string | null; count: number | null };

const path = (workId: string) => `/works/${encodeURIComponent(workId)}/metadata`;

/** A field's row: its label (Edited when it is), the control, and under an edited field the source's value and Revert. */
function Field({ field, answer, onRevert, busy, children }: { field: WorkField; answer: WorkMetadata; onRevert: (field: WorkField) => void; busy: boolean; children: ReactNode }) {
  const edited = isEdited(answer, field);
  return (
    <li className="part-row-item settings-field edit-field" data-testid={`edit-${field}`} data-edited={edited ? "" : undefined}>
      <label>
        <span className="edit-field-name type-body">
          {FIELD_LABELS[field]}
          {edited && <span className="edit-field-mark type-label">{EDITED}</span>}
        </span>
        {children}
      </label>
      {edited && (
        <span className="edit-field-source type-label">
          <span className="edit-field-was">{sourceText(answer, field)}</span>
          <Button kind="quiet" aria-label={`${REVERT} ${FIELD_LABELS[field]}`} disabled={busy} onClick={() => onRevert(field)}>
            {REVERT}
          </Button>
        </span>
      )}
    </li>
  );
}

export function EditPage({ workId, admin, onChanged }: Props) {
  const [answer, setAnswer] = useState<WorkMetadata | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [narrators, setNarrators] = useState<Record<string, string>>({});
  const [line, setLine] = useState<Line>(null);
  const [busy, setBusy] = useState(false);
  const show = (value: WorkMetadata) => {
    setAnswer(value);
    setDraft(draftOf(value.values));
    setNarrators(Object.fromEntries(value.recordings.map((recording) => [recording.recordingId, joinList(recording.narrators)])));
  };
  useEffect(() => {
    if (!admin) return;
    let live = true;
    void api<WorkMetadata>(path(workId))
      .then((value) => live && show(value))
      .catch((error: Error) => live && setLine({ text: error.message, failed: true }));
    return () => {
      live = false;
    };
  }, [workId, admin]);

  const act = async (action: () => Promise<WorkMetadata | null>, done?: string) => {
    setBusy(true);
    setLine(null);
    try {
      const value = await action();
      if (value) show(value);
      onChanged();
      window.dispatchEvent(new Event("sonder:library-changed"));
      if (done) setLine({ text: done, failed: false });
    } catch (error) {
      setLine({ text: (error as Error).message, failed: true });
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: unknown) => api<WorkMetadata>(path(workId), { method: "PATCH", body: JSON.stringify(body) });
  const revert = (field: WorkField) => void act(() => patch({ revert: [field] }));
  const revertNarrators = (recordingId: string) =>
    void act(() => api<WorkMetadata>(`/recordings/${encodeURIComponent(recordingId)}/metadata`, { method: "PATCH", body: JSON.stringify({ narrators: null }) }));

  const problem = draft ? draftProblem(draft) : null;
  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (!answer || !draft || problem) return;
    const values = changedFields(answer, draft);
    const recordings = answer.recordings.filter((recording) => JSON.stringify(splitList(narrators[recording.recordingId] ?? "")) !== JSON.stringify(recording.narrators));
    if (!Object.keys(values).length && !recordings.length) {
      setLine({ text: NOTHING_TO_SAVE, failed: false });
      return;
    }
    void act(async () => {
      let value: WorkMetadata | null = null;
      setLine({ text: SAVING, failed: false });
      if (Object.keys(values).length) value = await patch({ values });
      for (const recording of recordings)
        value = await api<WorkMetadata>(`/recordings/${encodeURIComponent(recording.recordingId)}/metadata`, {
          method: "PATCH",
          body: JSON.stringify({ narrators: splitList(narrators[recording.recordingId] ?? "") }),
        });
      return value;
    }, SAVED);
  };
  const upload = (file: File) =>
    void act(() => {
      const body = new FormData();
      body.append("file", file);
      return api<WorkMetadata>(`/works/${encodeURIComponent(workId)}/cover`, { method: "POST", body });
    });
  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((previous) => (previous ? { ...previous, [field]: value } : previous));

  return (
    <div className="hardcover-page edit-page" data-testid="edit-page">
      <div className="hardcover-page-head">
        <PageHeader title={EDIT_TITLE} back parent={{ name: "book", workId }} named={() => "the book"} />
        {answer && <p className="hardcover-page-book type-label">{answer.values.title}</p>}
      </div>
      {!admin ? (
        <p className="hardcover-page-line type-label">{ADMIN_EDITS_LINE}</p>
      ) : !answer || !draft ? (
        line && (
          <p className="hardcover-page-line type-label" data-failed={line.failed ? "" : undefined} role={line.failed ? "alert" : "status"}>
            {line.text}
          </p>
        )
      ) : (
        <form className="edit-form" onSubmit={save}>
          <Group caption="Details">
            {TEXT_FIELDS.map((field) => (
              <Field key={field} field={field} answer={answer} onRevert={revert} busy={busy}>
                <input
                  className="edit-input type-body"
                  value={draft[field]}
                  inputMode={field === "year" ? "numeric" : undefined}
                  maxLength={field === "isbn" ? 20 : field === "asin" ? 10 : field === "year" ? 4 : 500}
                  onChange={(event) => set(field, event.target.value)}
                />
              </Field>
            ))}
            {(["abridged", "explicit"] as const).map((field) => (
              <Field key={field} field={field} answer={answer} onRevert={revert} busy={busy}>
                <Switch className="edit-switch" label={FIELD_LABELS[field]} on={!!draft[field]} onChange={(on) => set(field, on)} />
              </Field>
            ))}
          </Group>

          <SeriesGroup answer={answer} series={draft.series} busy={busy} onChange={(list) => set("series", list)} onRevert={() => revert("series")} />

          {answer.recordings.length > 0 && (
            <Group caption="Narrators">
              {answer.recordings.map((recording) => (
                <li key={recording.recordingId} className="part-row-item settings-field edit-field" data-testid={`edit-narrators-${recording.recordingId}`} data-edited={recording.edited ? "" : undefined}>
                  <label>
                    <span className="edit-field-name type-body">
                      {recording.label}
                      {recording.edited && <span className="edit-field-mark type-label">{EDITED}</span>}
                    </span>
                    <input className="edit-input type-body" value={narrators[recording.recordingId] ?? ""} maxLength={1000} onChange={(event) => setNarrators((previous) => ({ ...previous, [recording.recordingId]: event.target.value }))} />
                  </label>
                  {recording.edited && (
                    <span className="edit-field-source type-label">
                      <span className="edit-field-was">{joinList(recording.source) || "Not set"}</span>
                      <Button kind="quiet" aria-label={`${REVERT} narrators of ${recording.label}`} disabled={busy} onClick={() => revertNarrators(recording.recordingId)}>
                        {REVERT}
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </Group>
          )}

          <CoverGroup answer={answer} draft={draft} busy={busy} onAddress={(cover) => set("cover", cover)} onUpload={upload} onRevert={() => revert("cover")} />

          <Group caption="About">
            <Field field="description" answer={answer} onRevert={revert} busy={busy}>
              <textarea className="edit-input edit-description type-body" value={draft.description} maxLength={20000} rows={6} onChange={(event) => set("description", event.target.value)} />
            </Field>
          </Group>

          <div className="edit-save">
            <Button kind="primary" type="submit" disabled={busy || !!problem}>
              {SAVE}
            </Button>
            {(problem || line) && (
              <p className="hardcover-page-line type-label" data-failed={problem || line?.failed ? "" : undefined} role={problem || line?.failed ? "alert" : "status"}>
                {problem ?? line?.text}
              </p>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * The work's series: each with its position and Remove; Add a series takes an AudiobookDB series found by search
 * (`GET /api/discover/series`, #721's series search) or a series of the administrator's own by its name.
 */
function SeriesGroup({ answer, series, busy, onChange, onRevert }: { answer: WorkMetadata; series: SeriesEntry[]; busy: boolean; onChange: (list: SeriesEntry[]) => void; onRevert: () => void }) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<FoundSeries[] | null>(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<FoundSeries | null>(null);
  const [own, setOwn] = useState("");
  const [position, setPosition] = useState("");
  const asked = useRef(0);
  const edited = isEdited(answer, "series");
  const search = () => {
    const text = query.trim();
    if (text.length < 2) return;
    const ask = ++asked.current;
    setError("");
    setFound(null);
    void api<FoundSeries[]>(`/discover/series?${new URLSearchParams({ q: text.slice(0, 300) })}`)
      .then((list) => ask === asked.current && setFound(list))
      .catch((reason: Error) => ask === asked.current && (setFound([]), setError(reason.message)));
  };
  const entry = chosen ? seriesEntry(chosen, position, false) : own.trim() ? seriesEntry({ id: null, name: own }, position, true) : null;
  const add = () => {
    if (!entry) return;
    onChange([...series, entry]);
    setAdding(false);
    setQuery("");
    setFound(null);
    setChosen(null);
    setOwn("");
    setPosition("");
  };
  return (
    <div className="hardcover-page-group" data-testid="edit-series" data-edited={edited ? "" : undefined}>
      <Group caption={edited ? `Series · ${EDITED}` : "Series"}>
        {series.map((item, index) => (
          <Row
            key={`${item.id ?? item.name}:${index}`}
            label={seriesLabel(item)}
            control={
              <Button kind="quiet" aria-label={`${REMOVE} ${item.name}`} disabled={busy} onClick={() => onChange(series.filter((_, other) => other !== index))}>
                {REMOVE}
              </Button>
            }
          />
        ))}
        {!adding && <Row label={ADD_SERIES} disabled={busy} onClick={() => setAdding(true)} />}
        {edited && <Row label={`${REVERT} series`} value={sourceText(answer, "series")} disabled={busy} onClick={onRevert} />}
      </Group>
      {adding && (
        <div className="edit-series-add" data-testid="edit-series-add">
          <label className="hardcover-search-field">
            <input
              type="search"
              className="type-body"
              aria-label={SERIES_SEARCH_LABEL}
              placeholder={SERIES_SEARCH_LABEL}
              value={query}
              maxLength={300}
              enterKeyHint="search"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  search();
                }
              }}
            />
          </label>
          {found && found.length > 0 && (
            <ul className="edit-choices" role="radiogroup" aria-label="AudiobookDB series">
              {found.map((item) => (
                <li key={item.id}>
                  <button type="button" role="radio" aria-checked={chosen?.id === item.id} className="edit-choice type-body" onClick={() => (setChosen(item), setOwn(""))}>
                    <span>{item.name}</span>
                    <span className="type-label edit-choice-detail">{[item.author, item.count != null ? `${item.count} books` : null].filter(Boolean).join(" · ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {found && !found.length && !error && <p className="hardcover-page-line type-label">No series found</p>}
          {error && (
            <p className="hardcover-page-line type-label" data-failed="" role="alert">
              {error}
            </p>
          )}
          <div className="settings-field edit-inline">
            <label>
              <span className="type-body">{LOCAL_SERIES_LABEL}</span>
              <input className="edit-input type-body" value={own} maxLength={300} onChange={(event) => (setOwn(event.target.value), setChosen(null))} />
            </label>
            <label>
              <span className="type-body">{POSITION_LABEL}</span>
              <input className="edit-input edit-position type-body" inputMode="decimal" value={position} maxLength={8} onChange={(event) => setPosition(event.target.value)} />
            </label>
          </div>
          <div className="edit-actions">
            <Button kind="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button kind="secondary" onClick={search} disabled={query.trim().length < 2}>
              Search
            </Button>
            <Button kind="primary" disabled={!entry} onClick={add}>
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The cover: the one shown, an https address (typed, or a provider's picked from Find covers: shown by its address,
 * never stored, #721's licence rule), or an uploaded image; Revert gives the source's cover back.
 */
function CoverGroup({ answer, draft, busy, onAddress, onUpload, onRevert }: { answer: WorkMetadata; draft: Draft; busy: boolean; onAddress: (cover: string) => void; onUpload: (file: File) => void; onRevert: () => void }) {
  const [covers, setCovers] = useState<{ provider: string; url: string; title: string }[] | null>(null);
  const [looking, setLooking] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const edited = isEdited(answer, "cover");
  const find = () => {
    const text = [answer.values.title, answer.values.authors[0] ?? ""].join(" ").trim().slice(0, 200);
    setLooking(true);
    setCovers([]);
    let left = SEARCH_PROVIDERS.length;
    for (const provider of SEARCH_PROVIDERS)
      void api<CatalogueSearch>(`/catalogue/search?${new URLSearchParams({ q: text, provider })}`)
        .then((result) => {
          const found = (result[provider]?.results ?? []).flatMap((entry) => (entry.cover && /^https:\/\//.test(entry.cover) ? [{ provider: PROVIDER_NAMES[provider], url: entry.cover, title: entry.title }] : []));
          setCovers((previous) => [...(previous ?? []), ...found.filter((entry) => !(previous ?? []).some((other) => other.url === entry.url))]);
        })
        .catch(() => {})
        .finally(() => {
          left -= 1;
          if (!left) setLooking(false);
        });
  };
  return (
    <div className="hardcover-page-group" data-testid="edit-cover" data-edited={edited ? "" : undefined}>
      <Group caption={edited ? `Cover · ${EDITED}` : "Cover"}>
        <li className="part-row-item settings-field edit-cover-row">
          {draft.cover ? <img className="edit-cover" src={draft.cover} alt="Cover" /> : <span className="edit-cover edit-cover-blank" aria-hidden="true" />}
          <label className="edit-cover-address">
            <span className="type-body">{COVER_ADDRESS_LABEL}</span>
            <input className="edit-input type-body" value={draft.cover} maxLength={2000} inputMode="url" onChange={(event) => onAddress(event.target.value.trim())} />
          </label>
        </li>
        <Row label={UPLOAD_COVER} disabled={busy} onClick={() => file.current?.click()} />
        <Row label={FIND_COVERS} disabled={busy || looking} onClick={find} />
        {edited && <Row label={`${REVERT} cover`} disabled={busy} onClick={onRevert} />}
      </Group>
      <input
        ref={file}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        hidden
        data-testid="edit-cover-file"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (chosen) onUpload(chosen);
        }}
      />
      {covers && covers.length > 0 && (
        <ul className="edit-covers" aria-label="Covers found">
          {covers.map((cover) => (
            <li key={cover.url}>
              <button type="button" className="edit-cover-choice" aria-pressed={draft.cover === cover.url} aria-label={`${cover.title} (${cover.provider})`} onClick={() => onAddress(cover.url)}>
                <img src={cover.url} alt="" loading="lazy" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {covers && !covers.length && !looking && <p className="hardcover-page-line type-label">{NO_COVERS}</p>}
    </div>
  );
}
