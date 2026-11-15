export function workMediaStateLabel(
  mediaState: {
    state: "missing" | "queued" | "failed" | "available";
    holdReason?: "unreleased" | "empty_search" | null;
  } | null | undefined,
) {
  if (!mediaState) return null;
  if (mediaState.state === "available") return "Available";
  if (mediaState.state === "queued") return "Queued";
  if (mediaState.state === "failed") return "Failed";
  if (mediaState.holdReason === "unreleased") return "Unreleased";
  if (mediaState.holdReason === "empty_search") return "Missing";
  return "Missing";
}

/**
 * Whether the media state alone offers an audio retry: a failed acquisition, or an empty
 * search while the work has no audio. A hold stays stored while a work is playable (the
 * server returns it as stored, ADR 0011), so it must not offer a retry then.
 */
export function workMediaStateOffersRetry(
  mediaState: {
    state: "missing" | "queued" | "failed" | "available";
    holdReason?: "unreleased" | "empty_search" | null;
  } | null | undefined,
) {
  if (!mediaState) return false;
  if (mediaState.state === "failed") return true;
  return mediaState.holdReason === "empty_search" && mediaState.state !== "available";
}
