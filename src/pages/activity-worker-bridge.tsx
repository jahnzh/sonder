// A worker's controls on `#activity/server/<worker>` until the worker's page (#520) replaces this file: today's
// restart and switch of the old Activity page, moved here as they were (#519). The Server list stays in view; this
// sits under it on a phone and beside it on a desktop, where the worker's page will be.
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ApiError, api } from "../lib";
import type { ActivityProcess, ActivityWorkerHost } from "../types";

function ago(timestamp: number, now = Date.now()) {
  const minutes = Math.round(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
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

/** The place of the worker's page: the worker's id, and its controls of today. */
export function ActivityWorkerSlot({ process, onChanged }: { process: ActivityProcess; onChanged: () => void }) {
  const host = process.host;
  if (!host) return null;
  return (
    <section className="activity-worker-slot user-row activity-row" aria-label={host.hostId} data-testid={`activity-process-${process.id}`}>
      <h2 className="requests-heading">{host.hostId}</h2>
      <WorkerHostControls host={host} label={process.label} onChanged={onChanged} />
    </section>
  );
}
