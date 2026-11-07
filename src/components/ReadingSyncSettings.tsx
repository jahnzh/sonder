import { useCallback, useEffect, useState } from "react";
import { BookOpenText, Loader2 } from "lucide-react";
import { api } from "../lib";
import type { AlignmentJob, AlignmentPoolStatus } from "../reading-types";
import { AlignmentPoolStatusView } from "./AlignmentPoolStatusView";

type Backfill = {
  available: boolean;
  counts: {
    queued: number;
    running: number;
    ready: number;
    partial: number;
    failed: number;
  };
  next: AlignmentJob | null;
};
type BackfillResult = {
  queued: number;
  failed: number;
  skipped: {
    ready: number;
    inProgress: number;
    paused: number;
    notEligible: number;
  };
};
const labels = ["queued", "running", "ready", "partial", "failed"] as const;

export function ReadingSyncSettings({
  notify,
}: {
  notify: (text: string, error?: boolean) => void;
}) {
  const [state, setState] = useState<Backfill | null>(null);
  const [pool, setPool] = useState<AlignmentPoolStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingPool, setRefreshingPool] = useState(false);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    await Promise.all([
      api<Backfill>("/alignments/backfill").then(setState).catch(() => {}),
      api<AlignmentPoolStatus>("/alignments/pool").then(setPool).catch(() => {}),
    ]);
  }, []);
  const refreshPool = async () => {
    setRefreshingPool(true);
    try {
      setPool(await api<AlignmentPoolStatus>("/alignments/pool?fresh=1"));
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setRefreshingPool(false);
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const nextId = state?.next?.ebookId;
  useEffect(() => {
    if (!nextId || titles[nextId]) return;
    void api<{ title?: string }>(`/reader/${nextId}`)
      .then((book) =>
        setTitles((known) => ({ ...known, [nextId]: book.title || "Untitled" })),
      )
      .catch(() => {});
  }, [nextId, titles]);
  const start = async () => {
    setBusy(true);
    try {
      const result = await api<BackfillResult>("/alignments/backfill", {
        method: "POST",
      });
      notify(
        result.queued
          ? `Queued reading sync for ${result.queued} ${result.queued === 1 ? "title" : "titles"}.`
          : "No new titles needed reading sync.",
      );
      await refresh();
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const next = state?.next;
  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <span className="settings-section-icon">
          <BookOpenText size={20} />
        </span>
        <div>
          <h2>Reading sync</h2>
          <p>
            Queues every linked, language-matching title whose audio is already
            on the server. Timings are estimated.
          </p>
        </div>
      </div>
      <div className="settings-inline-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy || !state?.available}
          onClick={() => void start()}
        >
          {busy && <Loader2 className="spin" size={15} />} Prepare reading sync
          for all titles
        </button>
      </div>
      {state && !state.available && (
        <small>The alignment worker is not configured on this server.</small>
      )}
      {state && (
        <>
          <ul className="user-list" aria-label="Reading sync progress">
            {labels.map((label) => (
              <li key={label} className="user-row">
                <div className="user-row-name">
                  <strong>
                    {label[0].toUpperCase() + label.slice(1)}
                  </strong>
                  <span className="quiet-tag">{state.counts[label]}</span>
                </div>
              </li>
            ))}
          </ul>
          {next && (
            <small>
              Next: {titles[next.ebookId] || "Title"} · {next.status} ·{" "}
              {Math.round(next.progress * 100)}%
            </small>
          )}
        </>
      )}
      <AlignmentPoolStatusView
        pool={pool}
        refreshing={refreshingPool}
        onRefresh={() => void refreshPool()}
      />
    </section>
  );
}
