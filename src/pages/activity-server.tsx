// Activity › Server (#519, spec #513 "Server"; boards ActivityServer.dc.html, ActivityServerEmpty.dc.html,
// ActivityServerOffline.dc.html, ActivityServerPaused.dc.html, DesktopActivityServer.dc.html): the administrator's
// queues with a switch each, Prepare for all books, the workers and the torrent client, in three groups.
// The lines are written by activity-server-lines.ts. A worker's row opens `#activity/server/<worker>`, the worker's
// page (#520, activity-worker.tsx): on a phone in place of this list, on a desktop beside it. An address of a worker
// the server does not report shows Server.
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { WifiOff } from "lucide-react";
import { api } from "../lib";
import type { ActivityProcess, ActivityResponse } from "../types";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { Switch } from "../parts/Switch";
import { InfoMark } from "../parts/Tooltip";
import { Chevron } from "../parts/icons";
import { tip, type TipName } from "../tooltip-texts";
import { writeAddress } from "../routes";
import {
  NOT_TRACKED_LINE, lightsDot, prepareResult, prepareValue, queueLine, torrentLine, workerLine, workers,
  type QueueId,
} from "./activity-server-lines";
import { AttentionMark, ServerRow } from "./activity-server-row";
import { WorkerHeading, WorkerPage } from "./activity-worker";
import { findWorker } from "./activity-worker-lines";
import "./activity-server.css";

const POLL_MS = 15_000;

/** What `GET /api/alignments/backfill` answers (the parts this page reads). */
type Backfill = { available: boolean; counts: { ready: number } };
type BackfillResult = { queued: number };

/** A queue: its name, the pause sentence as its tooltip, its line and its switch. */
function QueueRow({
  process, info, activity, onChanged,
}: {
  process: ActivityProcess;
  info: TipName;
  activity: ActivityResponse;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  // What the switch was set to while the request runs, so it moves at once.
  const [asked, setAsked] = useState<boolean | null>(null);
  const on = asked ?? (!process.paused && !process.lockedBy);
  const change = async (next: boolean) => {
    setBusy(true);
    setFailure("");
    setAsked(next);
    try {
      await api(`/activity/processes/${encodeURIComponent(process.id)}/pause`, { method: "POST", body: JSON.stringify({ paused: !next }) });
      await onChanged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setAsked(null);
      setBusy(false);
    }
  };
  return (
    <ServerRow
      id={process.id}
      name={process.label}
      info={info}
      line={queueLine(process, activity.items)}
      failure={failure}
      mark={lightsDot(process)}
      control={
        process.pausable && (
          <Switch label={process.label} on={on} disabled={busy || !!process.lockedBy} onChange={(next) => void change(next)} />
        )
      }
    />
  );
}

/** Prepare for all books: the button queues reading sync for every eligible book, the value shows how many are ready. */
function PrepareRow({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [state, setState] = useState<Backfill | null>(null);
  const [busy, setBusy] = useState(false);
  const read = useCallback(() => api<Backfill>("/alignments/backfill").then(setState).catch(() => {}), []);
  useEffect(() => {
    void read();
  }, [read]);
  const prepare = async () => {
    setBusy(true);
    try {
      const result = await api<BackfillResult>("/alignments/backfill", { method: "POST" });
      notify(prepareResult(result.queued));
      await read();
    } catch (error) {
      notify(error instanceof Error ? error.message : "That did not work.", true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label="Prepare for all books"
      info={<InfoMark name="Prepare for all books" text={tip("prepareAll")} />}
      control={
        <button
          type="button"
          className="activity-server-prepare type-label"
          aria-label="Prepare for all books"
          aria-busy={busy || undefined}
          disabled={busy || !state?.available}
          onClick={() => void prepare()}
        >
          {state && <span data-testid="prepare-ready">{prepareValue(state.counts.ready)}</span>}
          <Chevron />
        </button>
      }
    />
  );
}

/** A worker: a row that opens its page. Not in use is muted and has no mark. */
function WorkerRow({
  process, activity, chosen, onOpen,
}: {
  process: ActivityProcess;
  activity: ActivityResponse;
  chosen: boolean;
  onOpen: (worker: string) => void;
}) {
  const host = process.host!;
  const mark = lightsDot(process);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    // The address goes through the page stack (navigation.ts), as every move does.
    event.preventDefault();
    onOpen(host.hostId);
  };
  return (
    <li className="activity-server-item" data-testid={`server-worker-${host.hostId}`} data-muted={host.disabled ? "" : undefined} data-attention={mark ? "" : undefined}>
      <a className="activity-server-row activity-server-link" href={writeAddress({ name: "worker", worker: host.hostId })} aria-current={chosen ? "page" : undefined} onClick={open}>
        <span className="activity-server-text">
          <span className="activity-server-label type-body">{host.hostId}</span>
          <span className="activity-server-line type-label" data-testid="server-row-line" data-danger={mark ? "" : undefined}>
            {workerLine(process, activity.items)}
          </span>
        </span>
        <span className="activity-server-end">
          {mark && <AttentionMark />}
          <Chevron />
        </span>
      </a>
    </li>
  );
}

/** The queues of each group, with the tooltip each one's name carries. */
const READING_SYNC_QUEUES: Array<[QueueId, TipName]> = [["alignment", "syncQueue"]];
const DOWNLOAD_QUEUES_BEFORE: Array<[QueueId, TipName]> = [["acquisitions", "downloadQueue"]];
const DOWNLOAD_QUEUES_AFTER: Array<[QueueId, TipName]> = [["server-copies", "copies"], ["series-acquisition", "seriesSearch"]];
const OTHER_QUEUES: Array<[QueueId, TipName]> = [["ebook-set", "ebookChecks"], ["hardcover-sync", "hardcoverSync"], ["backups", "backups"]];

export function ActivityServer({
  online,
  worker,
  onWorker,
  onUnknownWorker,
  beside = false,
  notify,
}: {
  /** Whether the device has a connection: without one only the card shows. */
  online: boolean;
  /** The worker the address names (`#activity/server/<worker>`), if any. */
  worker?: string | null;
  /** Open a worker's address. */
  onWorker: (worker: string) => void;
  /** The address names a worker the server does not report: show Server instead. */
  onUnknownWorker?: () => void;
  /** A worker's page sits beside the list (a desktop) rather than in its place (a phone). */
  beside?: boolean;
  notify: (text: string, error?: boolean) => void;
}) {
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const answer = await api<ActivityResponse>("/activity");
      if (!alive.current) return;
      setActivity(answer);
      setError("");
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "Could not load activity.");
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!online) return () => void (alive.current = false);
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load, online]);
  const unknown = !!worker && !!activity && !findWorker(activity, worker);
  useEffect(() => {
    if (unknown) onUnknownWorker?.();
  }, [unknown, onUnknownWorker]);

  // On a phone the worker's page takes the list's place.
  const alone = !!worker && !beside && !unknown;
  if (!online)
    return (
      <div className="activity-server" data-testid="activity-server">
        {alone && <WorkerHeading hostId={worker} beside={false} />}
        <ul className="part-group activity-server-card" role="list" aria-label="No connection">
          <li className="activity-server-item">
            <div className="activity-server-row">
              <span className="activity-server-icon" aria-hidden="true">
                <WifiOff size={20} />
              </span>
              <span className="activity-server-text">
                <span className="type-body">No connection</span>
                <span className="activity-server-line type-label activity-server-wrap">The queues and workers show again when the connection is back.</span>
              </span>
            </div>
          </li>
        </ul>
      </div>
    );

  const processOf = (id: string) => activity?.processes.find((process) => process.id === id);
  const queues = (list: Array<[QueueId, TipName]>) =>
    activity
      ? list.flatMap(([id, info]) => {
          const process = processOf(id);
          return process ? [<QueueRow key={id} process={process} info={info} activity={activity} onChanged={load} />] : [];
        })
      : [];
  const torrent = processOf("torrent-client");
  const imports = processOf("imports");
  const hosts = activity ? workers(activity) : [];
  const poolFailure = processOf("alignment-pool");
  const chosen = worker ? hosts.find((process) => process.host?.hostId === worker) : undefined;

  if (alone)
    return (
      <div className="activity-server" data-testid="activity-server" aria-busy={!activity && !error ? true : undefined}>
        {chosen && activity ? (
          <WorkerPage process={chosen} items={activity.items} beside={false} onChanged={load} />
        ) : (
          <WorkerHeading hostId={worker} beside={false} />
        )}
        {error && (
          <p className="activity-server-error type-label" role="alert">
            {error}
          </p>
        )}
      </div>
    );

  return (
    <div className="activity-server" data-testid="activity-server" data-attention={activity?.attention} aria-busy={!activity && !error ? true : undefined}>
      <div className="activity-server-list">
        {error && (
          <p className="activity-server-error type-label" role="alert">
            {error}
          </p>
        )}
        {activity && (
          <>
            <Group caption="Reading sync">
              {queues(READING_SYNC_QUEUES)}
              <PrepareRow notify={notify} />
            </Group>
            {(hosts.length > 0 || poolFailure) && (
              <Group caption="Workers" info={<InfoMark name="Workers" text={tip("workers")} />}>
                {hosts.map((process) => (
                  <WorkerRow key={process.id} process={process} activity={activity} chosen={process === chosen} onOpen={onWorker} />
                ))}
                {poolFailure && (
                  <li className="activity-server-item" data-testid="server-row-alignment-pool">
                    <div className="activity-server-row">
                      <span className="activity-server-text">
                        <span className="activity-server-label type-body">{poolFailure.label}</span>
                        <span className="activity-server-line type-label">{poolFailure.reason}</span>
                      </span>
                    </div>
                  </li>
                )}
              </Group>
            )}
            <Group caption="Downloads">
              {queues(DOWNLOAD_QUEUES_BEFORE)}
              {torrent && <ServerRow id="torrent-client" name={torrent.label} info="torrent" line={torrentLine(torrent)} mark={lightsDot(torrent)} />}
              {queues(DOWNLOAD_QUEUES_AFTER)}
            </Group>
            <Group caption="Other">
              {queues(OTHER_QUEUES)}
              {imports && <ServerRow id="imports" name={imports.label} info="imports" line={NOT_TRACKED_LINE} muted />}
            </Group>
          </>
        )}
      </div>
      {chosen && activity && (
        <div className="activity-server-worker">
          <WorkerPage process={chosen} items={activity.items} beside onChanged={load} />
        </div>
      )}
    </div>
  );
}
