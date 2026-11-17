import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "../lib";
import type { ActivityItem, ActivityResponse } from "../types";

const POLL_MS = 15_000;

function ago(timestamp: number, now = Date.now()) {
  const minutes = Math.round(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const stateLabel = { running: "Running", queued: "Waiting", paused: "Paused", failed: "Failed", done: "Finished" } as const;

/** One button press: runs the request, shows its failure on the row, and reloads the page data. */
function useRowAction(onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const run = async (path: string, body: unknown) => {
    setBusy(true);
    setFailure("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      onChanged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, failure, run };
}

function ItemRow({ item, labels, onChanged }: { item: ActivityItem; labels: Map<string, string>; onChanged: () => void }) {
  const attention = item.state === "failed" || !!item.stuck;
  const action = useRowAction(onChanged);
  const [confirming, setConfirming] = useState(false);
  const buttons: ReactNode[] = [];
  if (item.actions.includes("retry"))
    buttons.push(
      <button key="retry" type="button" className="button subtle" disabled={action.busy} data-testid="activity-retry"
        onClick={() => void action.run("/activity/items/retry", { id: item.id })}>
        {action.busy && <Loader2 className="spin" size={14} />} Retry now
      </button>,
    );
  if (item.actions.includes("resume"))
    buttons.push(
      <button key="resume" type="button" className="button subtle" disabled={action.busy} data-testid="activity-resume"
        onClick={() => void action.run("/activity/items/resume", { id: item.id })}>
        {action.busy && <Loader2 className="spin" size={14} />} Resume
      </button>,
    );
  if (item.actions.includes("discard"))
    buttons.push(
      confirming ? (
        <span key="discard" className="settings-inline-actions" role="group" aria-label="Confirm discard">
          <button type="button" className="button subtle" disabled={action.busy} data-testid="activity-discard-confirm"
            onClick={() => void action.run("/activity/items/discard", { id: item.id }).then(() => setConfirming(false))}>
            Discard for good
          </button>
          <button type="button" className="button subtle" disabled={action.busy} onClick={() => setConfirming(false)}>Keep it</button>
        </span>
      ) : (
        <button key="discard" type="button" className="button subtle" data-testid="activity-discard" onClick={() => setConfirming(true)}>
          Discard
        </button>
      ),
    );
  return (
    <li className="user-row activity-row" data-testid={`activity-item-${item.id}`} data-state={item.state} data-attention={attention || undefined}>
      <div className="user-row-name">
        <strong>{item.title}</strong>
        <span className="quiet-tag">{stateLabel[item.state]}</span>
        {item.progress !== null && item.state !== "done" && <span className="quiet-tag">{Math.round(item.progress * 100)}%</span>}
        {item.stuck && <span className="quiet-tag" data-testid="activity-stuck">{item.stuck.reason}</span>}
      </div>
      <small>
        {[
          labels.get(item.processId) ?? "",
          item.detail ?? "",
          item.user ? `for ${item.user}` : "",
          item.host ? `on ${item.host}` : "",
          `updated ${ago(item.updatedAt)}`,
        ].filter(Boolean).join(" · ")}
      </small>
      {item.error && <small className="form-error">{item.error}</small>}
      {buttons.length > 0 && <div className="settings-inline-actions">{buttons}</div>}
      {action.failure && <small className="form-error" role="alert">{action.failure}</small>}
    </li>
  );
}

/**
 * Today's item groups of the old Activity page, shown on Now under what Now shows already (#519), until Now's own
 * ticket (#521) builds Now. The administrator's only: someone else never reads the server's activity.
 */
export function ActivityItemGroups() {
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setActivity(await api<ActivityResponse>("/activity"));
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load activity.");
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const labels = new Map((activity?.processes ?? []).map((process) => [process.id, process.label] as const));
  const needsAttention = (activity?.items ?? []).filter((item) => item.state === "failed" || item.stuck);
  const rest = (activity?.items ?? []).filter((item) => !(item.state === "failed" || item.stuck));
  const groups: Array<[string, ActivityItem[]]> = [
    ["Needs attention", needsAttention],
    ["Running", rest.filter((item) => item.state === "running")],
    ["Waiting", rest.filter((item) => item.state === "queued" || item.state === "paused")],
    ["Finished in the last 24 hours", rest.filter((item) => item.state === "done")],
  ];

  return (
    <section className="activity-item-groups" aria-label="Server work">
      <div className="page-heading">
        <button type="button" className="button subtle" disabled={refreshing} onClick={() => void load()}>
          {refreshing ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {activity && (
        <div data-testid="activity-page" data-attention={activity.attention}>
          {groups.map(([title, items]) =>
            items.length ? (
              <section key={title}>
                <h3 className="requests-heading">{title}</h3>
                <ul className="user-list" aria-label={title}>
                  {items.map((item) => <ItemRow key={item.id} item={item} labels={labels} onChanged={() => void load()} />)}
                </ul>
              </section>
            ) : null,
          )}
          {activity.items.length === 0 && <p data-testid="activity-empty">No background work right now.</p>}
        </div>
      )}
    </section>
  );
}
