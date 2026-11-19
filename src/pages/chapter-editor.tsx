// A recording's chapters on the book's Edit page (#719 part c): one row per recording in the Chapters group, which
// opens the editor under it: each chapter's title and start (h:mm:ss over the whole recording), Remove, Add a chapter,
// Shift all by seconds, Look up chapters (the linked AudiobookDB release, or an ASIN), Save chapters and Revert. Kept
// in Sonder only: the files are never written, and a saved place never moves. Words and steps: src/chapter-edit.ts.
import { useEffect, useState } from "react";
import { api } from "../lib";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { Button } from "../parts/Button";
import type { ChapterLookup, RecordingChapter, RecordingChapters, WorkMetadata } from "../types";
import {
  ADD_CHAPTER,
  ASIN_LABEL,
  CHAPTERS_CAPTION,
  CHAPTERS_SAVED,
  REVERTED_CHAPTERS,
  LENGTH_UNKNOWN_LINE,
  LOOKING_UP,
  LOOK_UP_CHAPTERS,
  NO_CHAPTER_CHANGES,
  SAVE_CHAPTERS,
  SHIFT,
  SHIFT_LABEL,
  START_LABEL,
  TITLE_LABEL,
  addChapter,
  chaptersLine,
  chaptersOfDraft,
  draftOfChapters,
  formatStart,
  sameChapters,
  shiftChapters,
  type ChapterDraft,
} from "../chapter-edit";
import { REMOVE, REVERT } from "./edit-page-model";

type Line = { text: string; failed: boolean } | null;
const path = (recordingId: string) => `/recordings/${encodeURIComponent(recordingId)}/chapters`;

/** The Chapters group: each recording's count and source; a tap opens its editor. */
export function ChaptersGroup({ metadata, busy, onChanged }: { metadata: WorkMetadata; busy: boolean; onChanged: () => void }) {
  const [answers, setAnswers] = useState<Record<string, RecordingChapters>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [line, setLine] = useState<Line>(null);
  const ids = metadata.recordings.map((recording) => recording.recordingId).join("\n");
  useEffect(() => {
    let live = true;
    for (const recording of metadata.recordings)
      void api<RecordingChapters>(path(recording.recordingId))
        .then((value) => live && setAnswers((previous) => ({ ...previous, [value.recordingId]: value })))
        .catch((error: Error) => live && setLine({ text: error.message, failed: true }));
    return () => {
      live = false;
    };
    // The recordings, not the answer's other fields, decide what is read.
  }, [ids]);
  if (!metadata.recordings.length) return null;
  const shown = open ? answers[open] : undefined;
  return (
    <div className="hardcover-page-group" data-testid="edit-chapters">
      <Group caption={CHAPTERS_CAPTION}>
        {metadata.recordings.map((recording) => {
          const answer = answers[recording.recordingId];
          return (
            <Row
              key={recording.recordingId}
              label={recording.label}
              value={answer ? chaptersLine(answer) : ""}
              opens
              disabled={busy || !answer}
              onClick={() => setOpen(open === recording.recordingId ? null : recording.recordingId)}
            />
          );
        })}
      </Group>
      {line && (
        <p className="hardcover-page-line type-label" data-failed={line.failed ? "" : undefined} role={line.failed ? "alert" : "status"}>
          {line.text}
        </p>
      )}
      {shown && (
        <ChapterEditor
          key={shown.recordingId}
          answer={shown}
          onSaved={(value) => {
            setAnswers((previous) => ({ ...previous, [value.recordingId]: value }));
            onChanged();
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function ChapterEditor({ answer, onSaved, onClose }: { answer: RecordingChapters; onSaved: (value: RecordingChapters) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<ChapterDraft>(() => draftOfChapters(answer.chapters));
  const [from, setFrom] = useState<"audiobookdb" | null>(answer.from);
  const [shift, setShift] = useState("");
  const [asin, setAsin] = useState(answer.release ? "" : (answer.asin ?? ""));
  const [found, setFound] = useState<ChapterLookup | null>(null);
  const [line, setLine] = useState<Line>(null);
  const [busy, setBusy] = useState(false);
  const result = chaptersOfDraft(draft, answer.duration);
  const problem = "problem" in result ? result.problem : null;
  const set = (index: number, field: "title" | "start", value: string) => {
    setDraft((previous) => previous.map((row, other) => (other === index ? { ...row, [field]: value } : row)));
    setFrom(null);
  };
  const shown = (value: RecordingChapters, done?: string) => {
    setDraft(draftOfChapters(value.chapters));
    setFrom(value.from);
    onSaved(value);
    if (done) setLine({ text: done, failed: false });
  };
  const send = async (chapters: RecordingChapter[] | null, done: string) => {
    setBusy(true);
    setLine(null);
    try {
      const value = await api<RecordingChapters>(path(answer.recordingId), { method: "PUT", body: JSON.stringify({ chapters, from: chapters ? from : null }) });
      shown(value, done);
      window.dispatchEvent(new Event("sonder:library-changed"));
    } catch (error) {
      setLine({ text: (error as Error).message, failed: true });
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!("chapters" in result)) return;
    if (sameChapters(result.chapters, answer.chapters) && from === answer.from) return setLine({ text: NO_CHAPTER_CHANGES, failed: false });
    void send(result.chapters, CHAPTERS_SAVED);
  };
  const doShift = () => {
    if (!("chapters" in result)) return;
    const moved = shiftChapters(result.chapters, Number(shift.replace(",", ".")), answer.duration);
    if ("problem" in moved) return setLine({ text: moved.problem, failed: true });
    setDraft(draftOfChapters(moved.chapters));
    setFrom(null);
    setLine({ text: `Shifted by ${shift.trim()} s; Save chapters to keep it.`, failed: false });
  };
  const lookUp = async () => {
    setBusy(true);
    setFound(null);
    setLine({ text: LOOKING_UP, failed: false });
    try {
      const value = await api<ChapterLookup>(`${path(answer.recordingId)}/lookup`, { method: "POST", body: JSON.stringify(asin.trim() ? { asin: asin.trim() } : {}) });
      setFound(value);
      if (value.agrees) {
        setDraft(draftOfChapters(value.chapters));
        setFrom("audiobookdb");
        setLine({ text: `${value.chapters.length} chapters from AudiobookDB; Save chapters to keep them.`, failed: false });
      } else if (value.chapters.length) setLine(null);
      // The found chapters' note names the reason; with none found, the line does.
      else setLine({ text: value.reason ?? "These chapters cannot be taken.", failed: true });
    } catch (error) {
      setLine({ text: (error as Error).message, failed: true });
    } finally {
      setBusy(false);
    }
  };
  const placeable = answer.lengthKnown;
  return (
    <div className="edit-chapters" data-testid="chapter-editor" data-recording={answer.recordingId}>
      {!placeable && <p className="hardcover-page-line type-label">{LENGTH_UNKNOWN_LINE}</p>}
      <ol className="edit-chapter-list" aria-label={`Chapters of ${answer.label}`}>
        {draft.map((row, index) => (
          <li key={index} className="edit-chapter" data-testid="chapter-row">
            <span className="edit-chapter-number type-label">{index + 1}</span>
            <input className="edit-input type-body" aria-label={`${TITLE_LABEL} of chapter ${index + 1}`} value={row.title} maxLength={300} onChange={(event) => set(index, "title", event.target.value)} />
            <input
              className="edit-input edit-chapter-start type-body"
              aria-label={`${START_LABEL} of chapter ${index + 1}`}
              value={row.start}
              inputMode="decimal"
              maxLength={14}
              onChange={(event) => set(index, "start", event.target.value)}
            />
            <Button kind="quiet" aria-label={`${REMOVE} chapter ${index + 1}`} disabled={busy} onClick={() => (setDraft((previous) => previous.filter((_, other) => other !== index)), setFrom(null))}>
              {REMOVE}
            </Button>
          </li>
        ))}
      </ol>
      <div className="edit-actions edit-chapter-tools">
        <Button kind="secondary" disabled={busy || !placeable} onClick={() => (setDraft((previous) => addChapter(previous, previous.length - 1, answer.duration)), setFrom(null))}>
          {ADD_CHAPTER}
        </Button>
      </div>
      <div className="settings-field edit-inline edit-chapter-shift">
        <label>
          <span className="type-body">{SHIFT_LABEL}</span>
          <input className="edit-input type-body" inputMode="decimal" value={shift} maxLength={10} onChange={(event) => setShift(event.target.value)} />
        </label>
        <Button kind="secondary" disabled={busy || !shift.trim() || !!problem} onClick={doShift}>
          {SHIFT}
        </Button>
      </div>
      <div className="settings-field edit-inline edit-chapter-lookup">
        <label>
          <span className="type-body">{ASIN_LABEL}</span>
          <input className="edit-input type-body" value={asin} maxLength={10} placeholder={answer.release ? "Linked release" : ""} onChange={(event) => setAsin(event.target.value)} />
        </label>
        <Button kind="secondary" disabled={busy || (!answer.release && !asin.trim())} onClick={() => void lookUp()}>
          {LOOK_UP_CHAPTERS}
        </Button>
      </div>
      {found && !found.agrees && found.chapters.length > 0 && (
        <Group caption={`Found on AudiobookDB${found.lengthMs ? ` · ${formatStart(found.lengthMs / 1000)}` : ""}`} note={found.reason ?? undefined} noteFailed>
          {found.chapters.map((chapter, index) => (
            <Row key={index} label={chapter.title} value={formatStart(chapter.start)} />
          ))}
        </Group>
      )}
      <div className="edit-save">
        <Button kind="primary" disabled={busy || !!problem || !placeable} onClick={save}>
          {SAVE_CHAPTERS}
        </Button>
        {answer.edited && (
          <Button kind="secondary" aria-label={`${REVERT} chapters of ${answer.label}`} disabled={busy} onClick={() => void send(null, REVERTED_CHAPTERS)}>
            {REVERT}
          </Button>
        )}
        <Button kind="quiet" disabled={busy} onClick={onClose}>
          Close
        </Button>
        {(problem || line) && (
          <p className="hardcover-page-line type-label" data-failed={problem || line?.failed ? "" : undefined} role={problem || line?.failed ? "alert" : "status"}>
            {problem ?? line?.text}
          </p>
        )}
      </div>
    </div>
  );
}
