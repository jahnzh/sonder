import { useState } from "react";
import { api } from "../lib";
import type { Download, SavedEbook } from "../types";

export type SeriesWorkView = {
  id: number;
  title: string;
  position: number | null;
  workId: string | null;
  added?: boolean;
  finished?: boolean;
  completionOverride?: "finished" | "unread" | null;
  libraryOriginLabel?: string | null;
  availability?: {
    audio: {
      server: boolean | null;
      recordings: { id: string; tracks: string[]; server: boolean; stream: boolean }[];
    };
    ebook: {
      server: boolean | null;
      editionIds?: string[];
      device: boolean | null;
    };
  };
};

export function SeriesWorkStatus({
  work,
  downloads,
  savedEbooks,
  onUpdated,
}: {
  work: SeriesWorkView;
  seriesId: number;
  downloads: Download[];
  savedEbooks: SavedEbook[];
  onUpdated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const audio = work.availability?.audio;
  const deviceAudio =
    work.workId &&
    audio?.recordings.some(
      (recording) =>
        recording.tracks.length > 0 &&
        recording.tracks.every((id) => downloads.some((download) => download.trackId === id)),
    );
  const deviceEbook =
    !!work.workId &&
    savedEbooks.some((ebook) => ebook.workId === work.workId && ebook.available);
  const completionValue =
    work.completionOverride === "finished"
      ? "finished"
      : work.completionOverride === "unread"
        ? "unread"
        : "derived";

  const setCompletion = async (status: "finished" | "unread" | "derived") => {
    if (!work.workId || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/works/${work.workId}/completion`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      onUpdated();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span>
        {work.added ? "In your series selection" : "Not added"}
        {work.finished ? " · Finished" : ""}
        {work.libraryOriginLabel ? ` · ${work.libraryOriginLabel}` : ""}
      </span>
      <span>
        Audio:{" "}
        {audio?.server == null
          ? "availability unknown"
          : audio.server
            ? "on server"
            : "not on server"}
        {work.workId ? (deviceAudio ? " · on device" : " · not on device") : ""}
        {audio?.recordings.some((recording) => recording.stream)
          ? " · stream availability unknown"
          : ""}
      </span>
      <span>
        Ebook:{" "}
        {work.availability?.ebook.server == null
          ? "availability unknown"
          : work.availability.ebook.server
            ? "on server"
            : "not on server"}
        {work.workId
          ? deviceEbook
            ? " · on device"
            : " · not on device"
          : ""}
      </span>
      {work.added && work.workId && (
        <label className="series-work-completion">
          Completion
          <select
            aria-label={`Completion for ${work.title}`}
            disabled={busy}
            value={completionValue}
            onChange={(event) =>
              void setCompletion(event.target.value as "finished" | "unread" | "derived")
            }
          >
            <option value="derived">Follow progress</option>
            <option value="finished">Finished</option>
            <option value="unread">Unread</option>
          </select>
        </label>
      )}
      {error && <span className="inline-error">{error}</span>}
    </>
  );
}
