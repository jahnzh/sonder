import { api } from "../lib";
import type { Download, SavedEbook, SeriesWorkAcquisition } from "../types";
import { workMediaStateLabel } from "../work-media-state";
import { SeriesWorkReleaseSearch } from "./SeriesWorkReleaseSearch";

const SERIES_SAVED_POLL_MS = 2500;

type Props = {
  seriesId: number;
  bookId: number;
  workId: string | null;
  workTitle: string;
  seriesAuthor: string | null;
  canAcquire: boolean;
  mediaState?: {
    state: "missing" | "queued" | "failed" | "available";
    holdReason?: "unreleased" | "empty_search" | null;
  } | null;
  acquisition?: {
    audio: SeriesWorkAcquisition | null;
    ebook: SeriesWorkAcquisition | null;
  } | null;
  ebookSet?: { held: number; accepted: number; rejected: number } | null;
  recordings?: { id: string; tracks: string[] }[];
  downloads: Download[];
  savedEbooks?: SavedEbook[];
  onRefresh: () => void;
};

function audioStatusLabel(
  mediaState: Props["mediaState"],
  acquisition: SeriesWorkAcquisition | null | undefined,
) {
  if (acquisition?.status === "searching" || acquisition?.status === "pending")
    return "Searching";
  if (acquisition?.status === "failed")
    return acquisition.error || "Search failed";
  if (mediaState?.state === "queued") return "Queued";
  if (mediaState?.state === "failed") return "Download failed";
  if (mediaState?.state === "available") return "Available";
  if (mediaState?.holdReason === "empty_search") return "No results";
  if (mediaState?.holdReason === "unreleased") return "Unreleased";
  const label = workMediaStateLabel(mediaState);
  return label || "Missing";
}

function ebookStatusLabel(
  acquisition: SeriesWorkAcquisition | null | undefined,
  ebookSet: Props["ebookSet"],
) {
  if (acquisition?.status === "searching" || acquisition?.status === "pending")
    return "Searching";
  if (acquisition?.status === "failed")
    return acquisition.error === "no_permission"
      ? "Not available for your account"
      : acquisition.error || "Search failed";
  if (acquisition?.skipReason === "has_ebook") return "Already on server";
  if (ebookSet?.accepted) return `${ebookSet.accepted} accepted`;
  if (ebookSet?.held) return `${ebookSet.held} held for review`;
  if (ebookSet?.rejected) return "Candidates rejected";
  if (acquisition?.status === "done") return "Search complete";
  return "Not searched";
}

function canRetryAudio(
  mediaState: Props["mediaState"],
  acquisition: SeriesWorkAcquisition | null | undefined,
) {
  if (acquisition?.status === "failed") return true;
  if (mediaState?.state === "failed") return true;
  if (mediaState?.holdReason === "empty_search") return true;
  return false;
}

function canRetryEbook(acquisition: SeriesWorkAcquisition | null | undefined) {
  return acquisition?.status === "failed" && acquisition.error !== "no_permission";
}

export function SeriesWorkStatus({
  seriesId,
  bookId,
  workId,
  workTitle,
  seriesAuthor,
  canAcquire,
  mediaState,
  acquisition,
  ebookSet,
  recordings,
  downloads,
  savedEbooks,
  onRefresh,
}: Props) {
  const onDevice = recordings?.some((recording) =>
    recording.tracks.length > 0 &&
    recording.tracks.every((trackId) =>
      downloads.some((download) => download.trackId === trackId),
    ),
  );
  const ebookOnDevice =
    !!workId &&
    !!savedEbooks?.some((ebook) => ebook.workId === workId && ebook.available);
  const retry = async (kind: "audio" | "ebook") => {
    await api(`/series/${seriesId}/works/${bookId}/acquisition/retry`, {
      method: "POST",
      body: JSON.stringify({ kind }),
    });
    onRefresh();
  };
  return (
    <>
      <span>
        Audio: {audioStatusLabel(mediaState, acquisition?.audio)}
        {onDevice ? " · on device" : " · not on device"}
        {canRetryAudio(mediaState, acquisition?.audio) && (
          <>
            {" "}
            <button type="button" className="button subtle" onClick={() => void retry("audio")}>
              Retry audio
            </button>
          </>
        )}
        {canAcquire && workId && (
          <>
            {" "}
            <SeriesWorkReleaseSearch
              seriesId={seriesId}
              bookId={bookId}
              workId={workId}
              title={workTitle}
              author={seriesAuthor}
              hasPlayableAudio={mediaState?.state === "available"}
              onRefresh={onRefresh}
            />
          </>
        )}
      </span>
      <span>
        Ebook: {ebookStatusLabel(acquisition?.ebook, ebookSet)}
        {savedEbooks?.length && workId
          ? (ebookOnDevice ? " · on device" : " · not on device")
          : ""}
        {canRetryEbook(acquisition?.ebook) && (
          <>
            {" "}
            <button type="button" className="button subtle" onClick={() => void retry("ebook")}>
              Retry ebook
            </button>
          </>
        )}
      </span>
    </>
  );
}

export { SERIES_SAVED_POLL_MS };
