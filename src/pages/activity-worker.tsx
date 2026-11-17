// The worker's page (#520, spec #513 "The worker's page"; boards Worker.dc.html, WorkerNotInUse.dc.html and the right
// half of DesktopActivityServer.dc.html): `#activity/server/<worker>`. On a phone it is a page of its own with a
// Page header whose back button goes back, or to Server when the page was opened by a link; on a desktop it sits
// beside the Server list under a heading of its own. The values are written by activity-worker-lines.ts.
import { useState } from "react";
import { ApiError, api } from "../lib";
import type { ActivityItem, ActivityProcess } from "../types";
import { Button } from "../parts/Button";
import { Group } from "../parts/Group";
import { PageHeader } from "../parts/PageHeader";
import { Row } from "../parts/Row";
import { Switch } from "../parts/Switch";
import { InfoMark } from "../parts/Tooltip";
import type { Route } from "../routes";
import { tip } from "../tooltip-texts";
import { ServerRow } from "./activity-server-row";
import {
  FORCEABLE_REFUSALS, WORKER_CAPTION, restartLine, workerDevice, workerNowValue, workerRevision, workerStatus,
} from "./activity-worker-lines";

/** The back button is named for Activity, wherever in Activity it lands (Server, or Now's Needs attention). */
const backNamed = (route: Route) => (route.name === "activity" ? "Activity" : null);

/** The header of the page: the worker's id and its caption. A Page header on a phone, a heading beside the list on a desktop. */
export function WorkerHeading({ hostId, beside }: { hostId: string; beside: boolean }) {
  if (beside)
    return (
      <div className="activity-worker-heading">
        <h2 className="type-heading" id="activity-worker-title">
          {hostId}
        </h2>
        <span className="activity-worker-caption type-label">{WORKER_CAPTION}</span>
      </div>
    );
  return (
    <div className="activity-worker-head">
      <PageHeader title={hostId} back parent={{ name: "activity", part: "server" }} named={backNamed} />
      <p className="activity-worker-caption type-label">{WORKER_CAPTION}</p>
    </div>
  );
}

/** Restart: asks first, in place; a refusal because the worker is busy or cannot be read offers Restart anyway. */
function RestartRow({ process, onChanged }: { process: ActivityProcess; onChanged: () => Promise<void> }) {
  const host = process.host!;
  const [step, setStep] = useState<"idle" | "confirm" | "refused">("idle");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const restart = async (force: boolean) => {
    setBusy(true);
    setResult(null);
    try {
      const reply = await api<{ message?: string }>(`/activity/services/alignment-host:${encodeURIComponent(host.hostId)}/restart`, {
        method: "POST",
        body: JSON.stringify({ force }),
      });
      setStep("idle");
      setResult({ ok: true, text: reply.message ?? "Restarted." });
    } catch (error) {
      const text = error instanceof Error ? error.message : "The restart did not work.";
      // Only an unforced restart refused for one of these reasons may be forced; anything else ends the question.
      const forceable = !force && error instanceof ApiError && FORCEABLE_REFUSALS.includes(error.code ?? "");
      setStep(forceable ? "refused" : "idle");
      setResult({ ok: false, text });
    } finally {
      setBusy(false);
      await onChanged();
    }
  };
  const restarting = busy || host.restarting;
  const control =
    step === "idle" ? (
      <Button aria-label={`Restart ${host.hostId}`} disabled={restarting} aria-busy={restarting || undefined} onClick={() => setStep("confirm")}>
        {host.restarting ? "Restarting" : "Restart"}
      </Button>
    ) : (
      <span className="activity-worker-confirm" role="group" aria-label={`Confirm restart of ${host.hostId}`}>
        <Button
          kind="quiet"
          disabled={busy}
          onClick={() => {
            setStep("idle");
            setResult(null);
          }}
        >
          Cancel
        </Button>
        <Button disabled={busy} aria-busy={busy || undefined} onClick={() => void restart(step === "refused")}>
          {step === "refused" ? "Restart anyway" : "Restart now"}
        </Button>
      </span>
    );
  const last = host.lastRestart;
  return (
    <ServerRow
      id="restart"
      name="Restart"
      info="restart"
      // The result of this page's own request stands in for the last restart it just changed.
      line={result ? "" : restartLine(last)}
      danger={!!last && !last.ok}
      wrap
      result={result?.ok ? result.text : undefined}
      failure={result && !result.ok ? result.text : undefined}
      control={control}
    />
  );
}

/** Use this worker: off gives it no new work; work running there finishes. */
function UseRow({ process, onChanged }: { process: ActivityProcess; onChanged: () => Promise<void> }) {
  const host = process.host!;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  // What the switch was set to while the request runs, so it moves at once.
  const [asked, setAsked] = useState<boolean | null>(null);
  const change = async (next: boolean) => {
    setBusy(true);
    setFailure("");
    setAsked(next);
    try {
      await api(`/activity/services/alignment-host:${encodeURIComponent(host.hostId)}/disable`, {
        method: "POST",
        body: JSON.stringify({ disabled: !next }),
      });
      await onChanged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setAsked(null);
      setBusy(false);
    }
  };
  return (
    <div className="activity-worker-use">
      <Group label="Use this worker">
        <Row
          label="Use this worker"
          info={<InfoMark name="Use this worker" text={tip("useWorker")} />}
          control={<Switch label="Use this worker" on={asked ?? !host.disabled} disabled={busy} onChange={(next) => void change(next)} />}
        />
      </Group>
      {failure && (
        <p className="activity-server-error type-label" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

/** The rows of a worker the server reports: Status, Device, Now, Code version; Use this worker; Restart. */
export function WorkerPage({
  process,
  items,
  beside,
  onChanged,
}: {
  process: ActivityProcess;
  items: ActivityItem[];
  /** Beside the Server list (a desktop), or a page of its own (a phone). */
  beside: boolean;
  onChanged: () => Promise<void>;
}) {
  const host = process.host!;
  return (
    <section
      className="activity-worker"
      data-testid="activity-worker"
      data-worker={host.hostId}
      aria-labelledby={beside ? "activity-worker-title" : undefined}
      aria-label={beside ? undefined : host.hostId}
    >
      <WorkerHeading hostId={host.hostId} beside={beside} />
      <Group caption="Status">
        <Row label="Status" value={workerStatus(process)} />
        <Row label="Device" value={workerDevice(process)} />
        <Row label="Now" value={workerNowValue(process, items)} />
        <Row label="Code version" value={workerRevision(process)} info={<InfoMark name="Code version" text={tip("codeVersion")} />} />
      </Group>
      {/* Keyed by the worker, so choosing another one on a desktop starts its controls afresh. */}
      <UseRow key={`use-${host.hostId}`} process={process} onChanged={onChanged} />
      <Group label="Restart">
        <RestartRow key={`restart-${host.hostId}`} process={process} onChanged={onChanged} />
      </Group>
    </section>
  );
}
