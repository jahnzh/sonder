import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { ApiError, api } from "../lib";
import type { ActivityItem, ActivityProcess, ActivityResponse, ActivityWorkerHost } from "../types";

const POLL_MS = 15_000;

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

/** Refusals a forced restart may override: the host runs work, or its status cannot be read. */
const FORCEABLE = new Set(["host_busy", "host_unreadable"]);

/** An alignment worker host's status and controls (#357): restart with a confirmation, and the disable switch. */
function WorkerHostControls({ host, label, onChanged }: { host: ActivityWorkerHost; label: string; onChanged: () => void }) {
  const [step, setStep] = useState<"idle" | "confirm" | "refused">("idle");
  const [busy, setBusy] = useState<"" | "restart" | "switch">("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const restart = async (force: boolean) => {
    setBusy("restart");
    setMessage(null);
    try {
      const reply = await api<{ message?: string }>(`/activity/services/alignment-host:${encodeURIComponent(host.hostId)}/restart`, {
        method: "POST", body: JSON.stringify({ force }),
      });
      setStep("idle");
      setMessage({ ok: true, text: reply.message ?? "Restarted." });
    } catch (error) {
      const text = error instanceof Error ? error.message : "The restart did not work.";
      setStep(!force && error instanceof ApiError && FORCEABLE.has(error.code ?? "") ? "refused" : "idle");
      setMessage({ ok: false, text });
    } finally {
      setBusy("");
      onChanged();
    }
  };
  const toggle = async () => {
    setBusy("switch");
    setMessage(null);
    try {
      await api(`/activity/services/alignment-host:${encodeURIComponent(host.hostId)}/disable`, {
        method: "POST", body: JSON.stringify({ disabled: !host.disabled }),
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "That did not work." });
    } finally {
      setBusy("");
      onChanged();
    }
  };
  const last = host.lastRestart;
  const current = [host.work ?? "", ...host.jobs].filter(Boolean).join(" · ");
  return (
    <>
      <small data-testid="activity-host-status">
        {[
          host.online ? "Online" : "Offline",
          host.device ?? "",
          `Code version ${host.revision ?? "unknown"}`,
        ].filter(Boolean).join(" · ")}
      </small>
      {host.online && <small data-testid="activity-host-job">{current ? `Current job: ${current}` : "Idle"}</small>}
      {!message && last && (
        <small className={last.ok ? undefined : "form-error"} data-testid="activity-host-last-restart">
          {last.message} ({ago(last.at)})
        </small>
      )}
      <div className="settings-inline-actions">
        {step === "idle" && (
          <button type="button" className="button subtle" disabled={!!busy || host.restarting} data-testid="activity-host-restart"
            aria-label={`Restart ${label}`} onClick={() => setStep("confirm")}>
            {(busy === "restart" || host.restarting) && <Loader2 className="spin" size={14} />} {host.restarting ? "Restarting" : "Restart"}
          </button>
        )}
        {step !== "idle" && (
          <span className="settings-inline-actions" role="group" aria-label={`Confirm restart of ${label}`}>
            <button type="button" className="button subtle" disabled={!!busy} data-testid="activity-host-restart-confirm"
              onClick={() => void restart(step === "refused")}>
              {busy === "restart" && <Loader2 className="spin" size={14} />} {step === "refused" ? "Restart anyway" : "Restart now"}
            </button>
            <button type="button" className="button subtle" disabled={busy === "restart"} onClick={() => { setStep("idle"); setMessage(null); }}>
              Cancel
            </button>
          </span>
        )}
        <button type="button" className="button subtle" disabled={!!busy} data-testid="activity-host-switch"
          aria-label={`${host.disabled ? "Enable" : "Disable"} ${label}`} onClick={() => void toggle()}>
          {busy === "switch" && <Loader2 className="spin" size={14} />} {host.disabled ? "Enable" : "Disable"}
        </button>
      </div>
      {message && (
        <small className={message.ok ? undefined : "form-error"} role={message.ok ? "status" : "alert"} data-testid="activity-host-result">
          {message.text}
        </small>
      )}
    </>
  );
}

function ProcessRow({ process, onChanged }: { process: ActivityProcess; onChanged: () => void }) {
  const action = useRowAction(onChanged);
  const { counts } = process;
  const detail = [
    process.notTracked ? "" : process.reason ?? "",
    process.notTracked ? "" : counts.running ? `${counts.running} running` : "",
    process.notTracked ? "" : counts.queued ? `${counts.queued} waiting` : "",
  ].filter(Boolean).join(" · ");
  return (
    <li className="user-row activity-row" data-testid={`activity-process-${process.id}`} data-health={process.health}>
      <div className="user-row-name">
        <strong>{process.label}</strong>
        <span className="quiet-tag">{process.type === "service" ? "Service" : "Background loop"}</span>
        {/* A loop that is held back is not "Running": the Paused or Disabled tag says what it is; so is an offline host you disabled. */}
        {!(process.health === "ok" && (process.paused || process.lockedBy)) && !(process.host?.disabled && process.health === "unknown") && (
          <span className="quiet-tag" data-testid="activity-process-health">
            {process.notTracked ? "Not tracked yet" : healthLabel[process.health]}
          </span>
        )}
        {process.since !== null && process.health !== "ok" && (
          <span className="quiet-tag">since {ago(process.since)}</span>
        )}
        {process.paused && <span className="quiet-tag" data-testid="activity-process-paused">Paused by you</span>}
        {process.lockedBy === "environment" && <span className="quiet-tag" data-testid="activity-process-locked">Disabled by environment</span>}
        {process.host?.disabled && <span className="quiet-tag" data-testid="activity-host-disabled">Disabled by you</span>}
      </div>
      {detail && <small>{detail}</small>}
      {process.host && <WorkerHostControls host={process.host} label={process.label} onChanged={onChanged} />}
      {process.pausable && process.pauseEffect && <small>{process.pauseEffect}</small>}
      {process.pausable && process.lockedBy === null && (
        <div className="settings-inline-actions">
          <button
            type="button"
            className="button subtle"
            disabled={action.busy}
            data-testid={`activity-pause-${process.id}`}
            aria-label={`${process.paused ? "Resume" : "Pause"} ${process.label}`}
            onClick={() => void action.run(`/activity/processes/${process.id}/pause`, { paused: !process.paused })}
          >
            {action.busy && <Loader2 className="spin" size={14} />} {process.paused ? "Resume" : "Pause"}
          </button>
        </div>
      )}
      {action.failure && <small className="form-error" role="alert">{action.failure}</small>}
    </li>
  );
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
            {activity.processes.map((process) => <ProcessRow key={process.id} process={process} onChanged={() => void load()} />)}
          </ul>
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
    </>
  );
}
