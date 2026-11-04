import { api } from "../lib";
import { workMediaStateLabel } from "../work-media-state";

type Acquisition = {
  kind: "audio" | "ebook";
  status: "pending" | "searching" | "done" | "failed" | "skipped";
  error?: string | null;
  skipReason?: "unreleased" | "has_audio" | "has_ebook" | "no_permission" | null;
};

type Props = {
  seriesId: number;
  bookId: number;
  mediaState?: {
    state: "missing" | "queued" | "failed" | "available";
    holdReason?: "unreleased" | "empty_search" | null;
  } | null;
  acquisition?: { audio: Acquisition | null; ebook: Acquisition | null } | null;
  ebookSet?: { held: number; accepted: number; rejected: number } | null;
  onRefresh: () => void;
};

function audioStatusLabel(
  mediaState: Props["mediaState"],
  acquisition: Acquisition | null | undefined,
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

function ebookStatusLabel(acquisition: Acquisition | null | undefined, ebookSet: Props["ebookSet"]) {
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
  acquisition: Acquisition | null | undefined,
) {
  if (acquisition?.status === "failed") return true;
  if (mediaState?.state === "failed") return true;
  if (mediaState?.holdReason === "empty_search") return true;
  return false;
}

function canRetryEbook(acquisition: Acquisition | null | undefined) {
  return acquisition?.status === "failed" && acquisition.error !== "no_permission";
}

export function SeriesWorkStatus({
  seriesId,
  bookId,
  mediaState,
  acquisition,
  ebookSet,
  onRefresh,
}: Props) {
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
        {canRetryAudio(mediaState, acquisition?.audio) && (
          <>
            {" "}
            <button type="button" className="button subtle" onClick={() => void retry("audio")}>
              Retry audio
            </button>
          </>
        )}
      </span>
      <span>
        Ebook: {ebookStatusLabel(acquisition?.ebook, ebookSet)}
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
