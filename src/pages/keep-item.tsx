// Keep on this device (#550, spec #548): the switch and its line, a failed save's Retry, the question Off asks in
// place and the earlier copies (#553). The Book page's This device group shows it, and so does Now playing's Listen
// face (#593), one component so the two cannot drift. Items of a Group (a list): the caller draws the Group.
import { useEffect, useState } from "react";
import { Button } from "../parts/Button";
import { ProgressBar } from "../parts/ProgressBar";
import { Switch } from "../parts/Switch";
import { InfoMark } from "../parts/Tooltip";
import { useEbookDeviceCopy } from "../ebook-device-copy";
import { keepOffAndRemove, keepSaver, removeEarlierCopy, resumeKeep, tapKeep, useDeviceBook, useKeepRecord, useKeptNeeds } from "../keep-runtime";
import type { DeviceSaveRecord } from "../device-saves";
import { bytes } from "../size-format";
import { tip } from "../tooltip-texts";
import type { Book, Download, DownloadPart, LibraryWork } from "../types";
import { chosenRecording, deviceHold, keepState } from "./book-model";
import "./book-page.css";

/** Removing the book's files from this device keeps these (board KeepOff.dc.html). */
export const KEEP_OFF_KEEPS = "Your place, bookmarks and library entry stay.";
/** Turning Keep off asks this, with the size of every file of the book on this device. */
export const keepOffQuestion = (size: number) => `Remove ${bytes(size)} from this device? ${KEEP_OFF_KEEPS}`;
/** An earlier copy's Remove asks this (board KeepEarlier.dc.html). */
export const earlierQuestion = (size: number) => `Remove ${bytes(size)} from this device?`;

type Running = Record<string, { progress: number; chapter: number; total: number }>;

export type KeepItemsProps = {
  workId: string;
  work: LibraryWork;
  /** The chosen EPUB (#531), whose copy Keep saves; null without one. */
  chosenEpub: string | null;
  /** The book of `GET /api/books` of the chosen recording, when there is one. */
  chosenBook: Book | null;
  online: boolean;
  downloads: Download[];
  downloadParts: DownloadPart[];
  /** Saves to this device that are running now, by recording. */
  running: Running;
  /** The device's records of its saves (#517): how a kept book's last save stopped (#552). */
  records?: readonly DeviceSaveRecord[];
  /** Today's save of a recording to this device: Resume of a book that is not kept. */
  onSave: (book: Book) => void;
  /** This device's files changed. */
  onDevice: () => Promise<void> | void;
  /** A step failed: its message, shown by the caller; "" clears it. */
  onError: (message: string) => void;
  /** Ids unique on the screen for the row's name and line. */
  idPrefix?: string;
};

export function KeepItems(props: KeepItemsProps) {
  const { workId, work, chosenEpub, chosenBook, online, downloads, downloadParts, running, onError } = props;
  const prefix = props.idPrefix ?? "book-keep";
  // Keep on this device is the work's Keep record on this device (#550); undefined while it is read.
  const keepRecord = useKeepRecord(workId);
  const [confirmKeepOff, setConfirmKeepOff] = useState(false);
  // The earlier copy whose Remove asks in place (#553), by recording.
  const [confirmEarlier, setConfirmEarlier] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setConfirmKeepOff(false);
    setConfirmEarlier(null);
  }, [workId]);
  const recording = chosenRecording(work);
  // Only a copy the user kept: the reader's own copy of a book it opened is a reading cache, not kept (#671).
  const epubCopy = useEbookDeviceCopy(chosenEpub ?? work.ebooks[0]?.id ?? null, { kept: true });
  const hold = deviceHold(recording, downloads, downloadParts);
  const epubSize = chosenEpub && epubCopy.known ? epubCopy.size : null;
  const needs = useKeptNeeds(work, downloads, downloadParts);
  // The save of the book: its recording's, or for a book with only an ebook its EPUB's (#551).
  const saveId = recording ? recording.recordingId : needs?.ebook ? `ebook:${needs.ebook.id}` : null;
  const job = saveId ? running[saveId] : undefined;
  const saveRecord = saveId ? props.records?.find((r) => r.recordingId === saveId) : undefined;
  // How the kept book's last save stopped (#552): a failure waits for Retry, a pause (on any tab) for Resume.
  const stop =
    saveRecord?.state === "failed"
      ? { why: "failed" as const, failure: saveRecord.failure ?? null }
      : keepRecord?.pausedAt || saveRecord?.state === "paused"
        ? { why: "paused" as const }
        : null;
  const keep = keepState({
    keep: keepRecord?.on === true,
    hold,
    saving: job ? { filesSaved: Math.max(0, job.chapter - 1), filesTotal: job.total } : null,
    ebookSize: epubSize,
    hasRecording: !!recording && recording.tracks.length > 0,
    needs,
    stop,
  });
  // Every file of the book on this device (#553): what Off frees and the earlier copies.
  const onDevice = useDeviceBook(work);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    onError("");
    try {
      await action();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // On stores the choice and asks the saver to make this device hold the book; the saver saves the chosen
  // recording, the chosen EPUB and the pair's map now, and whatever of them arrives later (#551). Only this tap asks
  // for persistent storage (`tap`).
  const keepOn = () => {
    onError("");
    void tapKeep(workId, true).catch((e: Error) => onError(e.message));
  };
  // Resume: a kept book's save is the saver's; another is today's save. Resume and Retry of a kept book clear its
  // pause and ask the tab that saves to save it again (#552).
  const resume = () => {
    if (keepRecord?.on && keepSaver()) void resumeKeep(workId).catch((e: Error) => onError(e.message));
    else if (chosenBook) props.onSave(chosenBook);
  };
  // Off (#553): removes every file of the book from this device (its recordings, complete and partial, earlier copies
  // included, its EPUB copies, its maps and its save records) and writes off. The place, bookmarks and library entry
  // stay. Remove on Activity's This device is the same action.
  const keepOff = () =>
    run(async () => {
      await keepOffAndRemove(workId, work);
      await props.onDevice();
      setConfirmKeepOff(false);
    });
  // The switch turned off asks in place with the size; with nothing on the device it turns off without asking.
  const switchOff = () => {
    if (onDevice?.any) setConfirmKeepOff(true);
    else void keepOff();
  };
  const removeEarlier = (recordingId: string) =>
    run(async () => {
      await removeEarlierCopy(workId, recordingId);
      await props.onDevice();
      setConfirmEarlier(null);
    });

  return (
    <>
      <li className="book-page-keep-item" aria-labelledby={`${prefix}-name${keep.line ? ` ${prefix}-line` : ""}`}>
        <div className="part-file-row book-page-keep" data-moving={job ? "" : undefined}>
          <span className="part-file-row-text">
            <span className="part-file-row-title">
              <span id={`${prefix}-name`} className="part-file-row-name type-body">
                Keep on this device
              </span>
              <InfoMark name="Keep on this device" text={tip("keep")} />
            </span>
            {keep.line && (
              <span id={`${prefix}-line`} className="part-file-row-status type-label" data-failed={keep.failed ? "" : undefined}>
                {keep.line}
              </span>
            )}
            {job && <ProgressBar progress={job.progress / 100} />}
          </span>
          <span className="part-file-row-end">
            {keep.resumable && !job && (chosenBook || keepRecord?.on) && (
              <Button kind="quiet" disabled={busy || !online} onClick={resume}>
                Resume
              </Button>
            )}
            <Switch
              label="Keep on this device"
              on={keep.on}
              disabled={busy || keepRecord === undefined}
              onChange={(on) => (on ? keepOn() : switchOff())}
            />
          </span>
        </div>
      </li>
      {/* A failed save: its reason in one line and Retry (board KeepNotComplete.dc.html). */}
      {keep.failed && keep.reason && !job && (
        <li className="part-file-row book-page-keep-failure">
          <span className="part-file-row-text">
            <span className="part-file-row-status type-label" id={`${prefix}-reason`}>
              {keep.reason}
            </span>
          </span>
          <span className="part-file-row-end">
            <Button aria-label="Retry saving on this device" aria-describedby={`${prefix}-reason`} disabled={busy || !online} onClick={resume}>
              Retry
            </Button>
          </span>
        </li>
      )}
      {/* Turning the switch off asks in place under the row (board KeepOff.dc.html); the switch stays on until Remove. */}
      {confirmKeepOff && (
        <li className="book-page-device-confirm" role="group" aria-label="Turn off Keep on this device">
          <span className="type-body">{keepOffQuestion(onDevice?.size ?? 0)}</span>
          <span className="book-page-device-confirm-buttons">
            <Button onClick={() => setConfirmKeepOff(false)}>Cancel</Button>
            <Button className="book-page-device-remove" disabled={busy} onClick={() => void keepOff()}>
              Remove
            </Button>
          </span>
        </li>
      )}
      {/* An earlier copy (board KeepEarlier.dc.html): a row per copy with Remove, which asks once in place. */}
      {keep.on &&
        (onDevice?.earlier ?? []).map((copy) => (
          <EarlierRow
            key={copy.recordingId}
            narrator={copy.narrator}
            size={copy.size}
            asking={confirmEarlier === copy.recordingId}
            busy={busy}
            onAsk={() => setConfirmEarlier(copy.recordingId)}
            onCancel={() => setConfirmEarlier(null)}
            onRemove={() => void removeEarlier(copy.recordingId)}
          />
        ))}
    </>
  );
}

/** An earlier copy's row: "Earlier recording", the narrator and its size, and Remove that asks once in place. */
function EarlierRow(props: { narrator: string; size: number; asking: boolean; busy: boolean; onAsk: () => void; onCancel: () => void; onRemove: () => void }) {
  const status = [props.narrator, bytes(props.size)].filter(Boolean).join(" · ");
  return (
    <>
      <li className="part-file-row book-page-earlier" data-asking={props.asking ? "" : undefined}>
        <span className="part-file-row-text">
          <span className="part-file-row-name type-body">Earlier recording</span>
          <span className="part-file-row-status type-label">{status}</span>
        </span>
        <span className="part-file-row-end">
          <Button aria-label="Remove the earlier recording from this device" aria-expanded={props.asking} disabled={props.busy} onClick={props.onAsk}>
            Remove
          </Button>
        </span>
      </li>
      {props.asking && (
        <li className="book-page-device-confirm" role="group" aria-label="Remove the earlier recording from this device">
          <span className="type-body">{earlierQuestion(props.size)}</span>
          <span className="book-page-device-confirm-buttons">
            <Button onClick={props.onCancel}>Cancel</Button>
            <Button className="book-page-device-remove" disabled={props.busy} onClick={props.onRemove}>
              Remove
            </Button>
          </span>
        </li>
      )}
    </>
  );
}
