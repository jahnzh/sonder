import { useState } from "react";
import { api } from "../lib";

export type SeriesWorkSavedDetailsView = {
  id: number;
  title: string;
  workId: string | null;
  added?: boolean;
  finished?: boolean;
  completionOverride?: "finished" | "unread" | null;
  libraryOriginLabel?: string | null;
};

export function SeriesWorkSavedDetails({
  work,
  onUpdated,
}: {
  work: SeriesWorkSavedDetailsView;
  onUpdated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      {work.libraryOriginLabel ? <span>{work.libraryOriginLabel}</span> : null}
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
