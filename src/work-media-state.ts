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
