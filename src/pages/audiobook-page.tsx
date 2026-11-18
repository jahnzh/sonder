// The Audiobook page (#530, spec #526 "The Audiobook page"; board Audiobook.dc.html): `#book/<workId>/audiobook`.
// Recordings (choose one; Get another recording), Available from (the copies, each opening its own small dialog),
// Plays from and Report a problem. It replaces "Versions & sources" (MediaManager) and the book dialog's release
// select. The words and choices are in audiobook-model.ts; switching recordings keeps today's Where to resume.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "../components/ui/dialog";
import { api, deleteDownloads, localDB } from "../lib";
import { useWork } from "../library-works-store";
import { useAddress } from "../navigation";
import { Button } from "../parts/Button";
import { ChoiceGroup } from "../parts/ChoiceRow";
import { Group } from "../parts/Group";
import { PageHeader } from "../parts/PageHeader";
import { Row } from "../parts/Row";
import { InfoMark } from "../parts/Tooltip";
import { usePlayer } from "../player";
import {
  clearStreamCache,
  deviceFault,
  deviceFaultKey,
  getRecordingSources,
  preferredSource,
  setPreferredSource,
} from "../playback-sources";
import {
  activeStamp,
  lowConfidenceWarning,
  replaceNotice,
  resumeLabel,
  savedLabel,
  sourceSwitchOffer,
  START_LABEL,
  type SourceSwitchOffer,
} from "../source-progress";
import { tip } from "../tooltip-texts";
import type { Book, Download, MediaFault, PlaybackSourceChoice, RecordingSources } from "../types";
import {
  copyRows,
  FAULT_REASONS,
  markDetail,
  markName,
  PLAYS_FROM_NAMES,
  playsFromOptions,
  recordingChoices,
  REMOVAL_KEEPS,
  reportScopes,
  SCOPE_NAMES,
  type CopyScope,
  type FaultScope,
  type Faults,
} from "./audiobook-model";
import "./audiobook-page.css";

type Props = {
  workId: string;
  /** Every book of `GET /api/books` the app holds: the recordings as the player plays them. */
  books: Book[];
  /** The complete files on this device. */
  downloads: Download[];
  admin: boolean;
  online: boolean;
  /** Get another recording: opens the Get audiobook sheet (#601). */
  onFindAudio: (book: Book) => void;
  /** The library or this device's copies changed. */
  onChanged: () => void;
};

type Pick<T extends string> = { value: T; label: string; disabled?: boolean };

/**
 * A short list to choose one from, in a dialog: one radio row per choice; a choice that is ruled out is off. With
 * `caption` its name is shown above it, as a Group's caption.
 */
export function PickList<T extends string>({ label, caption, options, value, onChoose }: { label: string; caption?: boolean; options: Pick<T>[]; value: T | null; onChoose: (value: T) => void }) {
  const id = useId();
  const list = (
    <ul className="audiobook-picks" role="radiogroup" aria-label={caption ? undefined : label} aria-labelledby={caption ? id : undefined}>
      {options.map((option) => (
        <li key={option.value}>
          <button
            type="button"
            role="radio"
            aria-checked={option.value === value}
            disabled={option.disabled}
            className="audiobook-pick type-body"
            data-chosen={option.value === value ? "" : undefined}
            onClick={() => onChoose(option.value)}
          >
            <span>{option.label}</span>
            {option.value === value && (
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12l5 5 9-10" />
              </svg>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
  if (!caption) return list;
  return (
    <div className="part-group-block">
      <h3 id={id} className="part-group-caption type-caption">
        {label}
      </h3>
      {list}
    </div>
  );
}

function Chevron() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** A row with an info mark whose control opens something: the mark is a button, so the value is the other one. */
function OpensRow({ label, value, info, name, onOpen, disabled }: { label: string; value?: string; info: ReactNode; name: string; onOpen: () => void; disabled?: boolean }) {
  return (
    <Row
      label={label}
      info={info}
      control={
        <button type="button" className="audiobook-row-open type-label" aria-label={name} onClick={onOpen} disabled={disabled}>
          {value}
          <Chevron />
        </button>
      }
    />
  );
}

type Offer = { target: Book; value: SourceSwitchOffer };
type Open = { kind: "copy"; scope: CopyScope } | { kind: "plays" } | { kind: "report" } | null;

export function AudiobookPage({ workId, books, downloads, admin, online, onFindAudio, onChanged }: Props) {
  const address = useAddress();
  const p = usePlayer();
  const { work, status, reload } = useWork(workId);
  const [chosenOverride, setChosenOverride] = useState<string | null>(null);
  const [sources, setSources] = useState<RecordingSources | null>(null);
  const [preference, setPreference] = useState<PlaybackSourceChoice>("auto");
  const [deviceMark, setDeviceMark] = useState<MediaFault | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [offer, setOffer] = useState<Offer | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [confirm, setConfirm] = useState<"device" | "server" | null>(null);
  const [scope, setScope] = useState<FaultScope>("recording");
  const [reason, setReason] = useState<MediaFault["reason"]>("bad-audio");
  const [note, setNote] = useState("");
  const startNoticeId = useId();

  const recordings = work?.recordings ?? [];
  // The tick follows a choice at once; the stored work catches up after its next read.
  const chosenId =
    (chosenOverride && recordings.some((r) => r.recordingId === chosenOverride) ? chosenOverride : null) ??
    work?.chosenRecordingId ??
    recordings[0]?.recordingId ??
    null;
  useEffect(() => {
    if (chosenOverride && work?.chosenRecordingId === chosenOverride) setChosenOverride(null);
  }, [chosenOverride, work?.chosenRecordingId]);
  const recording = recordings.find((r) => r.recordingId === chosenId) ?? null;
  const bookOf = useCallback((recordingId: string) => books.find((b) => b.recordingId === recordingId) ?? null, [books]);
  const book = chosenId ? bookOf(chosenId) : null;

  // An address that names nothing: no such work, no recording, or a work outside the library without a connection.
  const nothing = status === "missing" || status === "offline" || (status === "ready" && work !== null && recordings.length === 0);
  useEffect(() => {
    if (nothing) address.navigate({ name: "book", workId }, { replace: true });
  }, [nothing, workId]);

  // The chosen recording's sources, Plays from and this device's mark, read again when the copies change.
  const reading = useRef(0);
  const refresh = useCallback(async () => {
    if (!book) return;
    const request = ++reading.current;
    const [next, choice, mark] = await Promise.all([getRecordingSources(book), preferredSource(book.recordingId), deviceFault(book.recordingId)]);
    if (request !== reading.current) return;
    setSources(next);
    setPreference(choice);
    setDeviceMark(mark);
  }, [book?.recordingId, book]);
  useEffect(() => {
    setSources(null);
    setDeviceMark(undefined);
    if (!book) return;
    void refresh().catch((e: Error) => setError(e.message));
    const changed = () => void refresh().catch(() => {});
    window.addEventListener("sonder:downloads-changed", changed);
    window.addEventListener("online", changed);
    return () => {
      reading.current++;
      window.removeEventListener("sonder:downloads-changed", changed);
      window.removeEventListener("online", changed);
    };
  }, [book?.recordingId]);

  const faults: Faults = useMemo(
    () => ({ ...(sources?.faults ?? recording?.faults ?? {}), ...(deviceMark ? { device: deviceMark } : {}) }),
    [sources, recording, deviceMark],
  );
  const deviceFiles = useMemo(() => downloads.filter((file) => file.recordingId === chosenId), [downloads, chosenId]);
  const tracks = book?.tracks ?? recording?.tracks ?? [];
  const copies = copyRows({
    tracks,
    deviceFiles,
    sources,
    serverCopy: recording?.serverCopy ?? null,
    faults,
    sourceLabel: book?.sourceLabel ?? recording?.sourceLabel ?? "",
  });
  const playsThis = !!book && p.book?.recordingId === book.recordingId;
  const placeTrack = playsThis ? p.track : tracks.find((track) => track.id === (book?.progress ?? recording?.progress)?.trackId) ?? tracks[0];
  const available = sources?.tracks.find((track) => track.id === placeTrack?.id);
  const playsFrom = playsFromOptions({
    faults,
    deviceHasTrack: deviceFiles.some((file) => file.trackId === placeTrack?.id),
    serverHasTrack: !!available?.server,
    originalHasTrack: !!available?.original,
    online,
  });
  const scopes = reportScopes({ deviceFiles: deviceFiles.length, serverFiles: sources?.serverFiles ?? 0, originalFiles: sources?.originalFiles ?? 0 });

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      onChanged();
      window.dispatchEvent(new Event("sonder:library-changed"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stopIfPlaying = () => {
    if (playsThis) p.pause();
  };

  // Choosing a recording: stored for the user (it needs a connection), then playback switches when this book is in
  // the player. Where to resume follows source-progress: a newer own place switches without asking.
  const store = async (recordingId: string) => {
    await api(`/works/${encodeURIComponent(workId)}/recording`, { method: "PUT", body: JSON.stringify({ recordingId }) });
    setChosenOverride(recordingId);
  };
  const switchTo = (target: Book, start?: { trackId: string; position: number }) =>
    run(async () => {
      await store(target.recordingId);
      setOffer(null);
      const track = target.tracks.find((t) => t.id === start?.trackId);
      if (start && track) await p.play(target, track, start.position, { kind: "recording", saveAfterLoad: true });
      else await p.play(target, undefined, undefined, { kind: "recording" });
    });
  const choose = async (recordingId: string) => {
    if (busy || recordingId === chosenId && !(p.book?.workId === workId && p.book.recordingId !== recordingId)) return;
    const playing = p.book, track = p.track;
    const target = bookOf(recordingId);
    if (!playing || !track || playing.workId !== workId || playing.recordingId === recordingId || !target) {
      await run(() => store(recordingId));
      return;
    }
    const [activeSaved, targetSaved] = await Promise.all([localDB.progress.get(playing.recordingId), localDB.progress.get(recordingId)]);
    const value = sourceSwitchOffer({
      active: {
        recordingId: playing.recordingId,
        book: playing,
        trackId: track.id,
        position: p.position,
        updatedAt: activeStamp(
          playing,
          track.id,
          p.position,
          Math.max(activeSaved?.updatedAt || 0, bookOf(playing.recordingId)?.progress?.updatedAt || 0),
          Date.now(),
        ),
      },
      target: {
        recordingId,
        book: target,
        progress: targetSaved && targetSaved.updatedAt > (target.progress?.updatedAt || 0) ? targetSaved : target.progress,
      },
    });
    if (value) setOffer({ target, value });
    else await switchTo(target);
  };

  const choosePlaysFrom = (choice: PlaybackSourceChoice) =>
    run(async () => {
      if (!book) return;
      setOpen(null);
      await setPreferredSource(book.recordingId, choice);
      setPreference(choice);
      if (playsThis) await p.setPlaybackSource(choice);
    });
  const mark = () =>
    run(async () => {
      if (!book) return;
      const value = { reason, note, updatedAt: Date.now() };
      stopIfPlaying();
      if (scope === "device") await localDB.preferences.put({ key: deviceFaultKey(book.recordingId), value });
      else await api(`/recordings/${encodeURIComponent(book.recordingId)}/faults/${scope}`, { method: "PUT", body: JSON.stringify(value) });
      clearStreamCache();
      await setPreferredSource(book.recordingId, "auto");
      if (playsThis) await p.setPlaybackSource("auto");
      setOpen(null);
      setNote("");
    });
  const clear = (which: FaultScope) =>
    run(async () => {
      if (!book) return;
      if (which === "device") await localDB.preferences.delete(deviceFaultKey(book.recordingId));
      else await api(`/recordings/${encodeURIComponent(book.recordingId)}/faults/${which}`, { method: "DELETE" });
      clearStreamCache();
      if (playsThis) await p.setPlaybackSource(await preferredSource(book.recordingId));
    });
  const remove = (which: "device" | "server") =>
    run(async () => {
      if (!book) return;
      stopIfPlaying();
      if (which === "device") {
        await deleteDownloads(book.recordingId);
        await localDB.preferences.delete(deviceFaultKey(book.recordingId));
        window.dispatchEvent(new Event("sonder:downloads-changed"));
      } else await api(`/recordings/${encodeURIComponent(book.recordingId)}/server-copy`, { method: "DELETE" });
      clearStreamCache();
      await setPreferredSource(book.recordingId, "auto");
      if (playsThis) await p.setPlaybackSource("auto");
      setConfirm(null);
      setOpen(null);
    });
  const saveToServer = () =>
    run(async () => {
      if (!book) return;
      await api(`/books/${encodeURIComponent(book.id)}/keep`, { method: "POST" });
      setOpen(null);
      await reload();
    });

  if (!work || nothing) {
    return (
      <section className="audiobook-page" aria-label="Audiobook">
        <PageHeader title="Audiobook" back parent={{ name: "book", workId }} named={() => "the book"} />
      </section>
    );
  }

  const choices = recordingChoices(recordings).map((choice) =>
    choice.value === chosenId && faults.recording && !choice.detail.endsWith("Marked faulty")
      ? { ...choice, detail: [choice.detail, "Marked faulty"].filter(Boolean).join(" · ") }
      : choice,
  );
  const openCopy = open?.kind === "copy" ? copies.find((copy) => copy.scope === open.scope) ?? null : null;
  // Save to server, when the server has not all of the recording and no copy to it is running (administrator).
  const canSave = admin && !!book && !book.serverStored && !recording?.serverCopy && (sources?.serverFiles ?? 0) < tracks.length;
  const copyMark = openCopy ? faults[openCopy.scope] : undefined;
  const faultyRows = copies.map((copy) => (copy.faulty ? copy.scope : null)).filter(Boolean).join(" ");
  const playingError = playsThis ? p.error : "";

  return (
    <section className="audiobook-page" aria-label="Audiobook">
      <div className="audiobook-head">
        <PageHeader title="Audiobook" back parent={{ name: "book", workId }} named={() => "the book"} />
        <p className="audiobook-subtitle type-label">{work.title}</p>
      </div>

      <div className="part-group-block">
        <div className="part-group-caption-line">
          <h2 className="part-group-caption type-caption">Recordings</h2>
          <InfoMark name="Recordings" text={tip("recordings")} />
        </div>
        <ChoiceGroup label="Recordings" options={choices} value={chosenId} onChange={(value) => void choose(value)} />
        {admin && book && (
          <Group label="Get another recording">
            <Row label="Get another recording" opens onClick={() => onFindAudio(book)} />
          </Group>
        )}
      </div>

      <div className="audiobook-copies" data-faulty={faultyRows || undefined}>
        <Group caption="Available from" info={<InfoMark name="Available from" text={tip("audioFrom")} />}>
          {copies.map((copy) =>
            copy.present || (copy.scope === "server" && canSave) ? (
              <Row key={copy.scope} label={copy.name} value={copy.value} opens onClick={() => setOpen({ kind: "copy", scope: copy.scope })} />
            ) : (
              <Row key={copy.scope} label={copy.name} value={copy.value} />
            ),
          )}
        </Group>
      </div>

      <Group label="Playback" note={faults.recording ? markDetail(faults.recording) : undefined}>
        <OpensRow
          label="Plays from"
          value={PLAYS_FROM_NAMES[preference]}
          name={`Plays from: ${PLAYS_FROM_NAMES[preference]}`}
          info={<InfoMark name="Plays from" text={tip("playsFrom")} />}
          onOpen={() => setOpen({ kind: "plays" })}
          disabled={!book || !sources || busy}
        />
        {admin && (
          <OpensRow
            label="Report a problem"
            name="Report a problem"
            info={<InfoMark name="Report a problem" text={tip("problem")} />}
            onOpen={() => {
              setScope("recording");
              setOpen({ kind: "report" });
            }}
            disabled={!book}
          />
        )}
        {faults.recording && (
          <Row
            label={markName("recording")}
            control={
              admin ? (
                <Button kind="secondary" disabled={busy || !online} onClick={() => void clear("recording")}>
                  Clear the mark
                </Button>
              ) : undefined
            }
          />
        )}
      </Group>

      {(error || playingError) && (
        <p className="audiobook-error type-label" role="alert">
          {error || playingError}
        </p>
      )}

      <Dialog open={!!offer} onOpenChange={(next) => !next && setOffer(null)} title="Where to resume" className="audiobook-dialog">
        {offer && (
          <div className="audiobook-resume" role="group" aria-label="Where to resume">
            <Button kind="primary" disabled={busy} onClick={() => void switchTo(offer.target, offer.value.mapping)}>
              {resumeLabel(offer.value.mapping)}
            </Button>
            {offer.value.saved && (
              <Button kind="secondary" disabled={busy} onClick={() => void switchTo(offer.target, offer.value.saved!)}>
                {savedLabel(offer.target, offer.value.saved)}
              </Button>
            )}
            <Button
              kind="secondary"
              disabled={busy}
              aria-describedby={offer.value.saved ? `${startNoticeId}-start` : undefined}
              onClick={() => void switchTo(offer.target, { trackId: offer.target.tracks[0].id, position: 0 })}
            >
              {START_LABEL}
            </Button>
            {offer.value.saved && (
              <p id={`${startNoticeId}-start`} className="type-label">
                {replaceNotice(offer.target, offer.value.saved)}
              </p>
            )}
            {lowConfidenceWarning(offer.value.mapping) && (
              <p role="status" className="type-label">
                {lowConfidenceWarning(offer.value.mapping)}
              </p>
            )}
          </div>
        )}
      </Dialog>

      <Dialog open={open?.kind === "plays"} onOpenChange={(next) => !next && setOpen(null)} title="Plays from" className="audiobook-dialog">
        <PickList label="Plays from" options={playsFrom} value={preference} onChoose={(value) => void choosePlaysFrom(value)} />
      </Dialog>

      <Dialog open={!!openCopy} onOpenChange={(next) => !next && setOpen(null)} title={openCopy?.name ?? ""} className="audiobook-dialog">
        {openCopy && (
          <div className="audiobook-copy">
            {copyMark ? (
              <div className="audiobook-mark" role="status">
                <strong className="type-body">{markName(openCopy.scope)}</strong>
                <span className="type-label">{markDetail(copyMark)}</span>
              </div>
            ) : (
              <p className="type-label">{openCopy.value}</p>
            )}
            <div className="audiobook-actions">
              {copyMark && admin && (
                <Button kind="secondary" disabled={busy || (openCopy.scope !== "device" && !online)} onClick={() => void clear(openCopy.scope)}>
                  Clear the mark
                </Button>
              )}
              {openCopy.scope === "device" && deviceFiles.length > 0 && (
                <Button kind="secondary" disabled={busy} onClick={() => setConfirm("device")}>
                  Remove from this device
                </Button>
              )}
              {openCopy.scope === "server" && canSave && (
                <Button kind="primary" disabled={busy || !online} onClick={() => void saveToServer()}>
                  Save to server
                </Button>
              )}
              {openCopy.scope === "server" && admin && (sources?.managedCopies ?? 0) > 0 && (
                <Button kind="secondary" disabled={busy || !online} onClick={() => setConfirm("server")}>
                  Remove server copy
                </Button>
              )}
            </div>
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!confirm}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={confirm === "server" ? "Remove server copy?" : "Remove from this device?"}
        description={REMOVAL_KEEPS}
        className="audiobook-dialog"
      >
        <div className="audiobook-actions">
          <Button kind="secondary" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button kind="primary" disabled={busy} onClick={() => confirm && void remove(confirm)}>
            Remove
          </Button>
        </div>
      </Dialog>

      <Dialog open={open?.kind === "report"} onOpenChange={(next) => !next && setOpen(null)} title="Report a problem" className="audiobook-dialog">
        <form
          className="audiobook-report"
          onSubmit={(event) => {
            event.preventDefault();
            void mark();
          }}
        >
          <PickList
            caption
            label="What is faulty"
            options={scopes.map((value) => ({ value, label: SCOPE_NAMES[value] }))}
            value={scopes.includes(scope) ? scope : "recording"}
            onChoose={setScope}
          />
          <PickList
            caption
            label="Reason"
            options={(Object.keys(FAULT_REASONS) as MediaFault["reason"][]).map((value) => ({ value, label: FAULT_REASONS[value] }))}
            value={reason}
            onChoose={setReason}
          />
          <label className="audiobook-note type-label">
            Note
            <textarea className="type-body" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <Button kind="primary" type="submit" disabled={busy || (scope !== "device" && !online)}>
            Mark as faulty
          </Button>
        </form>
      </Dialog>
    </section>
  );
}
