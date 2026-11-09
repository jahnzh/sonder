import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "../lib";
import type { ActivityItem, ActivityProcess, ActivityResponse } from "../types";

const POLL_MS = 15_000;
const ATTENTION_POLL_MS = 60_000;

function ago(timestamp: number, now = Date.now()) {
  const minutes = Math.round(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const healthLabel = { ok: "Running", degraded: "Needs attention", down: "Down", unknown: "Not checked" } as const;
const stateLabel = { running: "Running", queued: "Waiting", paused: "Paused", failed: "Failed", done: "Finished" } as const;

/** How many items and processes need the administrator, for the indicator on Settings. */
export function useActivityAttention(enabled: boolean) {
  const [attention, setAttention] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setAttention(0);
      return;
    }
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      api<ActivityResponse>("/activity")
        .then((activity) => !cancelled && setAttention(activity.attention))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, ATTENTION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
  return attention;
}

function ProcessRow({ process }: { process: ActivityProcess }) {
  const { counts } = process;
  const detail = [
    process.reason ?? "",
    process.notTracked ? "" : counts.running ? `${counts.running} running` : "",
    process.notTracked ? "" : counts.queued ? `${counts.queued} waiting` : "",
  ].filter(Boolean).join(" · ");
  return (
    <li className="user-row" data-testid={`activity-process-${process.id}`} data-health={process.health}>
      <div className="user-row-name">
        <strong>{process.label}</strong>
        <span className="quiet-tag">{process.type === "service" ? "Service" : "Background loop"}</span>
        <span className="quiet-tag" data-testid="activity-process-health">
          {process.notTracked ? "Not tracked yet" : healthLabel[process.health]}
        </span>
        {process.since !== null && process.health !== "ok" && (
          <span className="quiet-tag">since {ago(process.since)}</span>
        )}
      </div>
      {detail && <small>{detail}</small>}
    </li>
  );
}

function ItemRow({ item, labels }: { item: ActivityItem; labels: Map<string, string> }) {
  const attention = item.state === "failed" || !!item.stuck;
  return (
    <li className="user-row" data-testid={`activity-item-${item.id}`} data-state={item.state} data-attention={attention || undefined}>
      <div className="user-row-name">
        <strong>{item.title}</strong>
        <span className="quiet-tag">{stateLabel[item.state]}</span>
        {item.progress !== null && item.state !== "done" && <span className="quiet-tag">{Math.round(item.progress * 100)}%</span>}
        {item.stuck && <span className="quiet-tag" data-testid="activity-stuck">{item.stuck.reason}</span>}
        {item.permanent && <span className="quiet-tag">Cannot succeed on retry</span>}
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
    </li>
  );
}

export function ActivityPage() {
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
    <>
      <div className="page-heading">
        <div>
          <h1>Activity</h1>
        </div>
        <button type="button" className="button subtle" disabled={refreshing} onClick={() => void load()}>
          {refreshing ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!activity && !error && <p><Loader2 className="spin" size={16} /> Loading</p>}
      {activity && (
        <div data-testid="activity-page" data-attention={activity.attention}>
          <h3 className="requests-heading">Background processes</h3>
          <ul className="user-list" aria-label="Background processes">
            {activity.processes.map((process) => <ProcessRow key={process.id} process={process} />)}
          </ul>
          {groups.map(([title, items]) =>
            items.length ? (
              <section key={title}>
                <h3 className="requests-heading">{title}</h3>
                <ul className="user-list" aria-label={title}>
                  {items.map((item) => <ItemRow key={item.id} item={item} labels={labels} />)}
                </ul>
              </section>
            ) : null,
          )}
          {activity.items.length === 0 && <p data-testid="activity-empty">No background work right now.</p>}
        </div>
      )}
    </>
  );
}
