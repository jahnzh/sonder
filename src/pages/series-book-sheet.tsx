// A book's search sheet over the Series page (#898, `#series/<id>/book/<bookId>`): what the series queue's searches
// for the book do, the audio search's chosen release with why it was chosen and a link to its page, the other releases
// it found (the Get sheet's choice rows) with Choose this one instead, and Search now, Search again and Skip for each
// search. The words and rules are in series-book-model.ts.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib";
import { useAddress } from "../navigation";
import { Button } from "../parts/Button";
import { ChoiceGroup } from "../parts/ChoiceRow";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { Sheet } from "../parts/Sheet";
import { GetSheetBook, SourceLinkLine } from "./get-sheet-parts";
import { sourceLink } from "./get-audiobook-rows";
import { chooseLine, seriesBookModel, type SearchSteering, type SeriesWorkSearch } from "./series-book-model";
import "./series-book-sheet.css";

type Props = {
  seriesId: string;
  bookId: string;
  /** The book's cover as its row shows it. */
  cover: string | null;
  online: boolean;
  /** A search was steered or a release chosen: the page reads the series again. */
  onChanged: () => void;
};

/** While a search of the book waits or runs, or its download is on its way, the sheet reads it again this often (as the page does). */
const POLL_MS = 2500;

const moving = (search: SeriesWorkSearch | null) =>
  [search?.audio, search?.ebook].some((state) => state?.status === "pending" || state?.status === "searching") ||
  search?.mediaState?.state === "queued";

export function SeriesBookSheet({ seriesId, bookId, cover, online, onChanged }: Props) {
  const address = useAddress();
  const path = `/series/${encodeURIComponent(seriesId)}/works/${encodeURIComponent(bookId)}/acquisition`;
  const [search, setSearch] = useState<SeriesWorkSearch | null>(null);
  // An action's failure stays until the next action; a read's failure until the next read that is answered.
  const [actionError, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const error = actionError || loadError;
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSearch(await api<SeriesWorkSearch>(path, { cache: "no-store" }));
      setLoadError("");
    } catch (reason) {
      setLoadError((reason as Error).message);
    }
  }, [path]);
  useEffect(() => {
    setSearch(null);
    setPicked(null);
    setError("");
    setLoadError("");
    void load();
  }, [load]);
  const isMoving = moving(search);
  useEffect(() => {
    if (!isMoving) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isMoving, load]);

  const model = useMemo(() => (search ? seriesBookModel(search) : null), [search]);
  const candidate = picked ? search?.choice?.candidates.find((entry) => entry.key === picked) ?? null : null;
  // A pick that is the chosen one by now (the page was read again) is no pick.
  const choosing = candidate && candidate.key !== search?.choice?.chosen ? candidate : null;

  const send = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const steer = (step: "now" | "again" | "skip", kind: "audio" | "ebook") =>
    send(() => api(`${path}/${step}`, { method: "POST", body: JSON.stringify({ kind }) }));
  const choose = () =>
    send(async () => {
      await api(`${path}/choose`, { method: "POST", body: JSON.stringify({ key: choosing!.key }) });
      setPicked(null);
    });

  const steering = (kind: "audio" | "ebook", name: string, rules: SearchSteering) =>
    rules.now || rules.again || rules.skip ? (
      <Group label={`${name} search`}>
        {rules.now && <Row label="Search now" disabled={busy || !online} onClick={() => void steer("now", kind)} />}
        {rules.again && <Row label="Search again" disabled={busy || !online} onClick={() => void steer("again", kind)} />}
        {rules.skip && <Row label="Skip" disabled={busy || !online} onClick={() => void steer("skip", kind)} />}
      </Group>
    ) : null;

  const line = choosing && search ? chooseLine(choosing, search) : null;
  const footer = model?.audio?.others.length ? (
    <>
      <SourceLinkLine link={choosing ? sourceLink(model.audio.others.find((row) => row.id === choosing.key)?.release) : null} />
      {line && (
        <p className={line.failed ? "get-sheet-line get-sheet-line-failed" : "get-sheet-line"} data-testid="choose-line">
          {line.text}
        </p>
      )}
      <Button kind="primary" disabled={!choosing || busy || !online} onClick={() => void choose()}>
        Choose this one instead
      </Button>
    </>
  ) : undefined;

  return (
    <Sheet title="Series search" parent={{ name: "series", id: seriesId }} footer={footer}>
      <GetSheetBook work={{ title: search?.title ?? "", cover: cover ?? "", author: "" }} />
      {!search && !error && <p className="series-book-line type-label">Loading…</p>}
      {search && (
        <Group label="Book">
          <Row label="Open book" opens onClick={() => address.navigate({ name: "book", workId: search.workId })} />
        </Group>
      )}
      {model?.audio && (
        <section className="series-book-part" aria-label="Audiobook">
          <h2 className="part-group-caption type-caption">Audiobook</h2>
          {model.audio.line && (
            <p className="series-book-line type-label" role="status">
              {model.audio.line}
            </p>
          )}
          {model.audio.chosen && (
            <div className="series-book-chosen" role="group" aria-label="Chosen">
              <span className="type-body">{model.audio.chosen.first}</span>
              {model.audio.chosen.second && <span className="series-book-muted type-label">{model.audio.chosen.second}</span>}
              <span className="series-book-muted type-label">{model.audio.chosen.why}</span>
              <SourceLinkLine link={model.audio.chosen.link} />
            </div>
          )}
          {model.audio.others.length > 0 && (
            <div className="part-group-block">
              <h3 className="part-group-caption type-caption">{model.audio.caption}</h3>
              <ChoiceGroup
                label={model.audio.caption}
                value={picked}
                onChange={(value) => setPicked(value)}
                options={model.audio.others.map((row) => ({ value: row.id, label: row.first, detail: row.second, edge: row.edge }))}
              />
            </div>
          )}
          {steering("audio", "Audiobook", model.audio.steering)}
        </section>
      )}
      {model?.ebook && (
        <section className="series-book-part" aria-label="Ebook">
          <h2 className="part-group-caption type-caption">Ebook</h2>
          {model.ebook.line && (
            <p className="series-book-line type-label" role="status">
              {model.ebook.line}
            </p>
          )}
          {steering("ebook", "Ebook", model.ebook.steering)}
        </section>
      )}
      {error && (
        <p className="series-book-error type-label" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
