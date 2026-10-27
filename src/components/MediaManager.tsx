import { useEffect, useRef, useState } from "react";
import {
  Layers,
  AlertTriangle,
  Check,
  Trash2,
  Download,
  HardDrive,
  Play,
} from "lucide-react";
import { Dialog } from "./ui/dialog";
import { usePlayer } from "../player";
import { api, localDB, deleteDownloads, bytes, clock } from "../lib";
import {
  getRecordingSources,
  preferredSource,
  setPreferredSource,
  deviceFault,
  deviceFaultKey,
  clearStreamCache,
} from "../playback-sources";
import type {
  Book,
  Download as DownloadRecord,
  MediaFault,
  PlaybackSourceChoice,
  RecordingSources,
} from "../types";
const reasons: Record<MediaFault["reason"], string> = {
  "wrong-language": "Wrong language",
  "wrong-book": "Wrong book or version",
  "bad-audio": "Audio does not play correctly",
  incomplete: "Missing or incomplete audio",
  other: "Other problem",
};
const scopeLabel = {
  recording: "Recording",
  server: "Server copy",
  original: "Original stream",
  device: "Device copy",
};
export function MediaManager({
  book,
  books,
  onClose,
  onChanged,
  onDownload,
  onBookDetails,
  notify,
}: {
  book: Book | null;
  books: Book[];
  onClose: () => void;
  onChanged: () => void;
  onDownload: (book: Book) => void;
  onBookDetails: (book: Book) => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const p = usePlayer();
  const [selectedId, setSelectedId] = useState(""),
    [state, setState] = useState<RecordingSources | null>(null),
    [files, setFiles] = useState<DownloadRecord[]>([]),
    [deviceFaults, setDeviceFaults] = useState<Record<string, MediaFault>>({}),
    [choice, setChoice] = useState<PlaybackSourceChoice>("auto"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [report, setReport] = useState(false),
    [scope, setScope] = useState<keyof typeof scopeLabel>("recording"),
    [reason, setReason] = useState<MediaFault["reason"]>("bad-audio"),
    [note, setNote] = useState(""),
    [removal, setRemoval] = useState<"device" | "server" | null>(null);
  const versions = books.filter(
    (version) => version.workId === book?.workId && version.tracks.length,
  );
  const selected =
    versions.find((version) => version.recordingId === selectedId) || book;
  const selection = useRef(selected?.recordingId);
  selection.current = book ? selected?.recordingId : undefined;
  const refreshRequest = useRef(0);
  const refresh = async () => {
    if (!selected) return;
    const request = ++refreshRequest.current;
    const [sources, downloaded, preference, faults] = await Promise.all([
      getRecordingSources(selected),
      localDB.downloads.toArray(),
      preferredSource(selected.recordingId),
      Promise.all(
        versions.map(
          async (version) =>
            [
              version.recordingId,
              await deviceFault(version.recordingId),
            ] as const,
        ),
      ),
    ]);
    if (selection.current !== selected.recordingId || request !== refreshRequest.current) return;
    setState(sources);
    setFiles(downloaded);
    setChoice(preference);
    setDeviceFaults(
      Object.fromEntries(
        faults.filter(
          (entry): entry is readonly [string, MediaFault] => !!entry[1],
        ),
      ),
    );
  };
  useEffect(() => {
    if (book) {
      setSelectedId(book.recordingId);
      setError("");
      setReport(false);
      setRemoval(null);
    }
  }, [book?.recordingId]);
  useEffect(() => {
    let live = true;
    setState(null);
    setReport(false);
    setError("");
    if (selected)
      void refresh().catch((error) => {
        if (live) setError(error.message);
      });
    const changed = () => void refresh().catch(() => {});
    window.addEventListener("sonder:downloads-changed", changed);
    window.addEventListener("online", changed);
    return () => {
      live = false;
      window.removeEventListener("sonder:downloads-changed", changed);
      window.removeEventListener("online", changed);
    };
  }, [selected?.recordingId, !!book]);
  if (!selected) return null;
  const actualTrack =
    p.book?.recordingId === selected.recordingId
      ? p.track
      : selected.tracks.find(
          (track) => track.id === selected.progress?.trackId,
        ) || selected.tracks[0];
  const available = state?.tracks.find((track) => track.id === actualTrack?.id);
  const deviceFiles = files.filter(
    (file) => file.recordingId === selected.recordingId,
  );
  const currentFaults = {
    ...state?.faults,
    ...(deviceFaults[selected.recordingId]
      ? { device: deviceFaults[selected.recordingId] }
      : {}),
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      onChanged();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stopped = () => {
    if (p.book?.recordingId === selected.recordingId) p.pause();
  };
  const mark = () =>
    run(async () => {
      const value = { reason, note, updatedAt: Date.now() };
      stopped();
      if (scope === "device")
        await localDB.preferences.put({
          key: deviceFaultKey(selected.recordingId),
          value,
        });
      else
        await api(`/recordings/${selected.recordingId}/faults/${scope}`, {
          method: "PUT",
          body: JSON.stringify(value),
        });
      clearStreamCache();
      await setPreferredSource(selected.recordingId, "auto");
      if (p.book?.recordingId === selected.recordingId)
        await p.setPlaybackSource("auto");
      setReport(false);
      notify(`${scopeLabel[scope]} marked faulty.`);
    });
  const clear = (scope: keyof typeof scopeLabel) =>
    run(async () => {
      if (scope === "device")
        await localDB.preferences.delete(deviceFaultKey(selected.recordingId));
      else
        await api(`/recordings/${selected.recordingId}/faults/${scope}`, {
          method: "DELETE",
        });
      clearStreamCache();
      if (p.book?.recordingId === selected.recordingId)
        await p.setPlaybackSource(await preferredSource(selected.recordingId));
      notify("Fault flag cleared.");
    });
  return (
    <>
      <Dialog
        open={!!book}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="Versions & sources"
        description="Choose a recording and manage its downloaded copies."
        className="media-manager-dialog"
      >
        <h2 className="media-manager-title">{book?.title}</h2>
        <div
          className="media-version-list"
          role="group"
          aria-label="Audiobook versions"
        >
          {versions.map((version) => {
            const local = files.filter(
              (file) => file.recordingId === version.recordingId,
            );
            const faulty =
              version.faults?.recording ||
              (version.recordingId === selected.recordingId
                ? state?.faults.recording
                : null);
            return (
              <button
                key={version.recordingId}
                className={`media-version ${version.recordingId === selected.recordingId ? "selected" : ""}`}
                aria-pressed={version.recordingId === selected.recordingId}
                onClick={() => setSelectedId(version.recordingId)}
              >
                <span>
                  <strong>{version.narrator}</strong>
                  <span>
                    {version.language || "Language unknown"} ·{" "}
                    {version.releaseTitle || version.sourceLabel}
                  </span>
                  <small>
                    {local.length
                      ? `${local.length}/${version.tracks.length} files on device · ${bytes(local.reduce((sum, file) => sum + file.size, 0))}`
                      : "No device copy"}{" "}
                    ·{" "}
                    {version.serverStored ? "Saved on server" : "Online source"}
                    {faulty ? " · Marked faulty" : ""}
                  </small>
                </span>
                {version.recordingId === selected.recordingId && (
                  <Check size={18} />
                )}
              </button>
            );
          })}
        </div>
        <div className="media-source-settings">
          <label>
            Playback source
            <select
              aria-label="Playback source choice"
              value={choice}
              onChange={(event) =>
                setChoice(event.target.value as PlaybackSourceChoice)
              }
              disabled={busy || !state}
            >
              <option value="auto">
                Automatic · prefer healthy downloaded copies
              </option>
              <option
                value="device"
                disabled={
                  !deviceFiles.some(
                    (file) => file.trackId === actualTrack?.id,
                  ) || !!currentFaults.device
                }
              >
                Device copy{currentFaults.device ? " · faulty" : ""}
              </option>
              <option
                value="server"
                disabled={
                  !available?.server ||
                  !!currentFaults.server ||
                  !navigator.onLine
                }
              >
                Server HDD copy{currentFaults.server ? " · faulty" : ""}
              </option>
              <option
                value="original"
                disabled={
                  !available?.original ||
                  !!currentFaults.original ||
                  !navigator.onLine
                }
              >
                {selected.tracks.some((track) => track.sourceType === "torbox")
                  ? "TorBox stream"
                  : "Original online stream"}
                {currentFaults.original ? " · faulty" : ""}
              </option>
            </select>
          </label>
          <p>
            Source changes keep your place in this recording. Another recording
            resumes its own saved position.
          </p>
          <button
            className="button primary"
            disabled={busy || !state || !!currentFaults.recording}
            onClick={() =>
              void run(async () => {
                await setPreferredSource(selected.recordingId, choice);
                if (p.book?.recordingId === selected.recordingId)
                  await p.setPlaybackSource(choice);
                else await p.play(selected);
              })
            }
          >
            <Play size={16} />{" "}
            {p.book?.recordingId === selected.recordingId
              ? "Apply source"
              : "Use this version"}
          </button>
          {p.book?.recordingId === selected.recordingId && (
            <p>
              Current position: {clock(p.position)} ·{" "}
              {p.source === "device"
                ? "Device cache"
                : p.source === "server"
                  ? "Server HDD"
                  : p.source === "torbox"
                    ? "TorBox"
                    : "Online stream"}
            </p>
          )}
        </div>
        {Object.entries(currentFaults).map(
          ([scope, fault]) =>
            fault && (
              <div className="media-fault" role="status" key={scope}>
                <strong>
                  <AlertTriangle size={16} />{" "}
                  {scopeLabel[scope as keyof typeof scopeLabel]} marked faulty
                </strong>
                <p>
                  {reasons[fault.reason]}
                  {fault.note ? ` · ${fault.note}` : ""}
                </p>
                <button
                  className="button subtle"
                  disabled={busy || (scope !== "device" && !navigator.onLine)}
                  onClick={() => void clear(scope as keyof typeof scopeLabel)}
                >
                  Clear fault flag
                </button>
              </div>
            ),
        )}
        <div className="media-management-actions">
          <button
            className="button subtle"
            onClick={() => setReport(!report)}
            aria-expanded={report}
          >
            <AlertTriangle size={16} /> Mark as faulty
          </button>
          <button
            className="button subtle"
            disabled={busy || !deviceFiles.length}
            onClick={() => setRemoval("device")}
          >
            <Trash2 size={16} /> Remove device copy
          </button>
          <button
            className="button subtle"
            disabled={busy || !state?.managedCopies || !navigator.onLine}
            onClick={() => setRemoval("server")}
          >
            <Trash2 size={16} /> Remove server copy
          </button>
          <button
            className="button subtle"
            onClick={() => onDownload(selected)}
            disabled={busy || deviceFiles.length === selected.tracks.length}
          >
            <Download size={16} /> Save on device
          </button>
          <button
            className="button subtle"
            disabled={busy || selected.serverStored || !navigator.onLine}
            onClick={() =>
              void run(async () => {
                await api(`/books/${selected.id}/keep`, { method: "POST" });
                notify("Saving this recording on the server HDD.");
              })
            }
          >
            <HardDrive size={16} /> Save on server
          </button>
          <button
            className="button subtle"
            onClick={() => {
              onClose();
              onBookDetails(selected);
            }}
          >
            <Layers size={16} /> Open title page
          </button>
        </div>
        {report && (
          <form
            className="media-fault-form"
            onSubmit={(event) => {
              event.preventDefault();
              void mark();
            }}
          >
            <label>
              What is faulty?
              <select
                aria-label="Faulty item"
                value={scope}
                onChange={(event) =>
                  setScope(event.target.value as typeof scope)
                }
              >
                <option value="recording">This recording / release</option>
                <option value="device" disabled={!deviceFiles.length}>
                  Device copy only
                </option>
                <option value="server" disabled={!state?.serverFiles}>
                  Server copy only
                </option>
                <option value="original" disabled={!state?.originalFiles}>
                  Original stream only
                </option>
              </select>
            </label>
            <label>
              Problem
              <select
                aria-label="Fault reason"
                value={reason}
                onChange={(event) =>
                  setReason(event.target.value as typeof reason)
                }
              >
                {Object.entries(reasons).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Notes (optional)
              <textarea
                aria-label="Fault notes"
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <button
              className="button primary"
              disabled={busy || (scope !== "device" && !navigator.onLine)}
            >
              Save fault report
            </button>
          </form>
        )}
        {(error || (p.book?.recordingId === selected.recordingId && p.error)) && (
          <p className="inline-error" role="alert">
            {error || p.error}
          </p>
        )}
      </Dialog>
      <Dialog
        open={!!removal}
        onOpenChange={(open) => {
          if (!open) setRemoval(null);
        }}
        title="Remove downloaded copy?"
        description={
          removal === "server"
            ? "Only the managed copy on your server HDD will be removed. Your library, progress and original files are retained. Reading sync may need preparing again after a new server download."
            : "Remove this recording’s audio files from this device. Your library and progress are retained."
        }
      >
        <div className="media-management-actions">
          <button className="button subtle" onClick={() => setRemoval(null)}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                stopped();
                if (removal === "device") {
                  await deleteDownloads(selected.recordingId);
                  await localDB.preferences.delete(
                    deviceFaultKey(selected.recordingId),
                  );
                  window.dispatchEvent(new Event("sonder:downloads-changed"));
                } else
                  await api(`/recordings/${selected.recordingId}/server-copy`, {
                    method: "DELETE",
                  });
                clearStreamCache();
                await setPreferredSource(selected.recordingId, "auto");
                if (p.book?.recordingId === selected.recordingId)
                  await p.setPlaybackSource("auto");
                setRemoval(null);
                notify("Downloaded copy removed.");
              })
            }
          >
            Remove copy
          </button>
        </div>
      </Dialog>
    </>
  );
}
