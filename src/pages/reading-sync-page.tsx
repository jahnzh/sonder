// The Reading sync page (#540, spec #537 "The page"; boards ReadingSync*.dc.html): `#book/<workId>/sync`, and its
// Details at `#book/<workId>/sync/details`. The Page header "Reading sync" with its tooltip and the book's title; the
// pair (Recording and Edition, opening the Audiobook and Ebook pages); the Status with its rows or steps; the state's
// buttons (#541: Pause, Cancel, Resume and Retry send `PATCH /api/alignments/<id>`, Prepare and Prepare again `POST
// /api/alignments` with the ebook and the recording only; the answer shows at once, the buttons are freed when the
// request answers whatever the listing does, a refusal shows the server's message under the buttons); Prepare
// again, Workers and Details; Unsynced passages last. What it shows is decided by src/pages/reading-sync-model.ts.
//
// The pair comes from the library by work on the device; the job from `GET /api/alignments?ebookId=<edition>` on
// open and every 4 seconds while the page is visible; the pool's count from `GET /api/alignments/pool` for the
// administrator on a stopped job.
import { useEffect, useRef, useState } from "react";
import { api } from "../lib";
import { useWork } from "../library-works-store";
import { useAddress } from "../navigation";
import { useDeviceEbookChoice } from "../ebook-device-copy";
import { chosenEbook } from "../ebook-choice";
import { Button } from "../parts/Button";
import { Group } from "../parts/Group";
import { PageHeader } from "../parts/PageHeader";
import { ProgressBar } from "../parts/ProgressBar";
import { Row } from "../parts/Row";
import { Steps } from "../parts/Steps";
import { InfoMark } from "../parts/Tooltip";
import { Tick } from "../parts/icons";
import { bytes } from "../size-format";
import { SYNC_DETAILS_VALUE } from "../status-lines";
import { tip } from "../tooltip-texts";
import type { AlignmentJob, AlignmentPoolStatus } from "../reading-types";
import { JOB_NOT_LISTED, runJobAction, shownAfterAction } from "../reading-sync-controls";
import type { LibraryWork, WorkEbook, WorkRecording } from "../types";
import { chosenRecording } from "./book-model";
import { recordingName } from "./audiobook-model";
import {
  needsPoolCount,
  readingSyncDetails,
  readingSyncPage,
  shownAfterPrepare,
  syncRequest,
  type ListedJob,
  type StatusBlock,
  type StatusRow,
  type SyncButton,
} from "./reading-sync-model";
import "./reading-sync-page.css";

/** How often the page reads the listing while it is visible. */
export const SYNC_POLL_MS = 4000;

/** The pair the page is for: the work's chosen recording and its chosen EPUB, as the Book page has them. */
export function syncPair(work: LibraryWork, deviceChoice: string | null | undefined): { recording: WorkRecording; ebook: WorkEbook } | null {
  const recording = chosenRecording(work);
  const ebook = chosenEbook(work, deviceChoice);
  return recording && ebook ? { recording, ebook } : null;
}

type Listing = {
  job: ListedJob | null | undefined;
  failed: boolean;
  /** Shows a job the server answered an action with, until the listing answers again. */
  show: (job: ListedJob) => void;
  /** Reads the listing now; resolves when it answers (or fails). */
  refresh: () => Promise<void>;
};

/**
 * The listing's job for the pair: read on open, after each action and every 4 seconds while the page is visible. A
 * read that began before the last action shown is dropped, so an older answer never replaces the server's answer.
 */
function useListedJob(ebookId: string | null, recordingId: string | null): Listing {
  const [listing, setListing] = useState<{ job: ListedJob | null | undefined; failed: boolean }>({ job: undefined, failed: false });
  const reader = useRef<{ read: () => Promise<void> }>({ read: async () => {} });
  const shownAt = useRef(0);
  const reads = useRef(0);
  useEffect(() => {
    setListing({ job: undefined, failed: false });
    reader.current = { read: async () => {} };
    if (!ebookId || !recordingId) return;
    let live = true;
    let timer: number | null = null;
    const read = async () => {
      const started = ++reads.current;
      try {
        const answer = await api<{ jobs: (ListedJob & { recordingId: string })[] }>(`/alignments?${new URLSearchParams({ ebookId })}`);
        const job = answer.jobs.find((entry) => entry.recordingId === recordingId) ?? null;
        if (live && started > shownAt.current) setListing({ job, failed: false });
      } catch {
        // No answer, or an answer with an error: the page shows the stored work's line and "No connection".
        if (live && started > shownAt.current) setListing((current) => ({ job: current.job, failed: true }));
      }
    };
    reader.current = { read };
    const schedule = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      if (document.visibilityState !== "visible") return;
      timer = window.setInterval(() => void read(), SYNC_POLL_MS);
    };
    const shown = () => {
      if (document.visibilityState === "visible") void read();
      schedule();
    };
    void read();
    schedule();
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("online", shown);
    return () => {
      live = false;
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("online", shown);
    };
  }, [ebookId, recordingId]);
  return {
    ...listing,
    show: (job) => {
      shownAt.current = reads.current;
      setListing({ job, failed: false });
    },
    refresh: () => reader.current.read(),
  };
}

/**
 * The page's buttons at work (#324, #541): every press sends its request or says why not; the server's answer is
 * shown at once; the buttons are freed when the request answers, whatever the listing does; a refused action leaves
 * the server's message for under the buttons.
 */
function useSyncActions(pair: { ebookId: string; recordingId: string } | null, listing: Listing) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const press = (button: SyncButton) => {
    if (!pair || busy) return;
    const job = listing.job ?? undefined;
    const request = syncRequest(button, pair, job?.id);
    if (!request) {
      setError(JOB_NOT_LISTED);
      return;
    }
    if (request.method === "PATCH") {
      void runJobAction(job, request.body.action, {
        send: () => api<AlignmentJob>(request.path, { method: "PATCH", body: JSON.stringify(request.body) }),
        show: (answer) => listing.show(job ? shownAfterAction(job as AlignmentJob, answer) : answer),
        refresh: listing.refresh,
        busy: setBusy,
        error: setError,
      });
      return;
    }
    setBusy(true);
    setError("");
    void api<AlignmentJob>(request.path, { method: "POST", body: JSON.stringify(request.body) })
      .then((answer) => {
        // The buttons are freed when the POST answers, not when the listing does (#324).
        setBusy(false);
        listing.show(shownAfterPrepare(listing.job, answer));
        return listing.refresh();
      })
      .catch((failure: Error) => setError(failure.message || "Could not connect. Please try again."))
      .finally(() => setBusy(false));
  };
  return { busy, error, press };
}

/** The browser says whether it is online. */
function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/** The page's work, pair and job; it leaves for the Book page when the work has no pair, and for the Library when there is no work. */
function useSyncPage(workId: string) {
  const address = useAddress();
  const { work, status } = useWork(workId);
  const deviceChoice = useDeviceEbookChoice(workId);
  const pair = work ? syncPair(work, deviceChoice) : null;
  const listing = useListedJob(pair?.ebook.id ?? null, pair?.recording.recordingId ?? null);
  const online = useOnline();
  useEffect(() => {
    // An address that names no work shows the Library, as the Book page does; a work without a recording or an EPUB
    // shows its Book page. Either replaces the entry.
    if (status === "missing" || status === "offline") address.navigate({ name: "library" }, { replace: true });
    else if (work && !pair) address.navigate({ name: "book", workId }, { replace: true });
  }, [status, !!work, !!pair, workId]);
  const stored = pair ? work?.readingSync.find((entry) => entry.recordingId === pair.recording.recordingId && entry.ebookId === pair.ebook.id) ?? null : null;
  return { work, status, pair, listing, offline: !online || listing.failed, stored };
}

/** The options' `languageMatch`, read once for a pair that has no job (the only state it decides). */
function useLanguageMatch(pair: { ebookId: string; recordingId: string } | null, needed: boolean): boolean | null {
  const [match, setMatch] = useState<{ key: string; value: boolean } | null>(null);
  const key = pair ? `${pair.ebookId} ${pair.recordingId}` : "";
  useEffect(() => {
    if (!pair || !needed || match?.key === key) return;
    let live = true;
    void api<{ languageMatch: boolean }>(`/alignments/options?${new URLSearchParams({ ebookId: pair.ebookId, recordingId: pair.recordingId })}`)
      .then((options) => live && setMatch({ key, value: options.languageMatch !== false }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, needed]);
  return match?.key === key ? match.value : null;
}

/** The pool's workers online out of those configured, read for the administrator on a stopped job. */
function usePoolCount(needed: boolean): { online: number; total: number } | null {
  const [count, setCount] = useState<{ online: number; total: number } | null>(null);
  useEffect(() => {
    if (!needed) return;
    let live = true;
    void api<AlignmentPoolStatus>("/alignments/pool")
      .then((pool) => {
        if (!live) return;
        const hosts = pool.hosts ?? [];
        setCount({ online: hosts.filter((host) => host.reachable && !host.disabled).length, total: hosts.length });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [needed]);
  return needed ? count : null;
}

function StatusRowItem({ row }: { row: StatusRow }) {
  const twoLines = !!row.line || row.progress != null;
  return (
    <li className="reading-sync-row" data-lines={twoLines ? "2" : "1"} aria-label={[row.name, row.line, row.value].filter(Boolean).join(", ")}>
      <span className="reading-sync-row-text">
        <span className="reading-sync-row-name">
          <span className="reading-sync-row-label type-body">{row.name}</span>
          {row.tip && <InfoMark name={row.name} text={tip(row.tip)} />}
        </span>
        {row.line && <span className="reading-sync-row-line type-label">{row.line}</span>}
        {row.progress != null && <ProgressBar progress={row.progress} />}
      </span>
      {(row.mark || row.value) && (
        <span className="reading-sync-row-end">
          {row.value && <span className="reading-sync-row-value type-label">{row.value}</span>}
          {row.mark === "ready" && <Tick className="reading-sync-tick" />}
          {row.mark === "attention" && <span className="reading-sync-attention" role="img" aria-label="Needs attention" />}
        </span>
      )}
    </li>
  );
}

function Block({ block }: { block: StatusBlock }) {
  return (
    <div className="part-group-block reading-sync-block">
      <div className="reading-sync-caption-line">
        <h2 className="part-group-caption type-caption">{block.caption}</h2>
        {block.tip && <InfoMark name={block.caption} text={tip(block.tip)} />}
        {block.value && <span className="reading-sync-caption-value type-label">{block.value}</span>}
      </div>
      {block.rows.length > 0 && (
        <ul className="part-group" role="list" aria-label={block.caption}>
          {block.rows.map((row, index) => (
            <StatusRowItem key={`${index}-${row.name}`} row={row} />
          ))}
        </ul>
      )}
      {block.steps && <Steps label="Steps" steps={block.steps} />}
    </div>
  );
}

/** The state's buttons. One alone is the main action, full width; Resume is the main one beside Cancel. */
function Buttons({ buttons, busy, press }: { buttons: SyncButton[]; busy: boolean; press: (button: SyncButton) => void }) {
  if (!buttons.length) return null;
  const alone = buttons.length === 1;
  return (
    <div className="reading-sync-buttons" data-alone={alone ? "" : undefined}>
      {buttons.map((name, index) => (
        <Button key={name} kind={alone || (name === "Resume" && index === 0) ? "primary" : "secondary"} disabled={busy} onClick={() => press(name)}>
          {name}
        </Button>
      ))}
    </div>
  );
}

function pairValue(ebook: WorkEbook) {
  return [ebook.format.toUpperCase(), ebook.size > 0 ? bytes(ebook.size) : null].filter(Boolean).join(" · ");
}

export function ReadingSyncPage({ workId, admin }: { workId: string; admin: boolean }) {
  const address = useAddress();
  const { work, status, pair, listing, offline, stored } = useSyncPage(workId);
  const job = offline ? undefined : listing.job;
  const ids = pair ? { ebookId: pair.ebook.id, recordingId: pair.recording.recordingId } : null;
  const languageMatch = useLanguageMatch(ids, job === null);
  const actions = useSyncActions(ids, listing);
  const pool = usePoolCount(admin && needsPoolCount(job));
  const header = (
    <PageHeader title="Reading sync" back parent={{ name: "book", workId }} info={<InfoMark name="Reading sync" text={tip("syncTitle")} />} />
  );
  if (!work || !pair)
    return (
      <div className="reading-sync-page" data-status={status}>
        {header}
        {status === "loading" && <p className="reading-sync-book type-label">Loading…</p>}
      </div>
    );
  const model = readingSyncPage({ admin, job, offline, stored, languageMatch, pool, now: Date.now() });
  const actionRows = model.prepareAgainRow || model.workers || model.details;
  return (
    <div className="reading-sync-page" data-state={model.state}>
      {header}
      <p className="reading-sync-book type-label">{work.title}</p>
      <Group label="Recording and edition">
        <Row label="Recording" value={recordingName(pair.recording)} opens onClick={() => address.navigate({ name: "book-page", workId, page: "audiobook" })} />
        <Row label="Edition" value={pairValue(pair.ebook)} opens onClick={() => address.navigate({ name: "book-page", workId, page: "ebook" })} />
      </Group>
      {model.state === "loading" && <p className="reading-sync-note type-label">Loading…</p>}
      {model.blocks.map((block, index) => (
        <Block key={`${index}-${block.caption}`} block={block} />
      ))}
      <Buttons buttons={model.buttons} busy={actions.busy} press={actions.press} />
      {model.note && <p className="reading-sync-note">{model.note}</p>}
      {actions.error && (
        <p className="reading-sync-error type-label" role="alert">
          {actions.error}
        </p>
      )}
      {actionRows && (
        <Group label="Reading sync actions">
          {model.prepareAgainRow && (
            <li className="reading-sync-row reading-sync-again" data-lines={model.prepareAgainRow.line ? "2" : "1"}>
              <span className="reading-sync-row-text">
                <span className="reading-sync-row-name">
                  <button type="button" className="reading-sync-row-button type-body" disabled={actions.busy} onClick={() => actions.press("Prepare again")}>
                    Prepare again
                  </button>
                  <InfoMark name="Prepare again" text={tip("prepareAgain")} />
                </span>
                {model.prepareAgainRow.line && <span className="reading-sync-row-line type-label">{model.prepareAgainRow.line}</span>}
              </span>
            </li>
          )}
          {model.workers && <Row label="Workers" value={model.workers} opens onClick={() => address.navigate({ name: "activity", part: "server" })} />}
          {model.details && <Row label="Details" value={SYNC_DETAILS_VALUE} opens onClick={() => address.navigate({ name: "sync-details", workId })} />}
        </Group>
      )}
      {model.passages && model.passages.length > 0 && (
        <Group caption={`Unsynced passages · ${model.passages.length}`} info={<InfoMark name="Unsynced passages" text={tip("unsynced")} />}>
          {model.passages.map((passage, index) => (
            <StatusRowItem key={index} row={{ name: passage.title, line: passage.line }} />
          ))}
        </Group>
      )}
    </div>
  );
}

/** Details (`#book/<workId>/sync/details`): Engine, GPU use, Processing time, the stage times, the warning, the older engine's line and flags. */
export function ReadingSyncDetailsPage({ workId }: { workId: string }) {
  const { work, status, pair, listing, offline } = useSyncPage(workId);
  const header = <PageHeader title="Details" back parent={{ name: "book-page", workId, page: "sync" }} />;
  if (!work || !pair)
    return (
      <div className="reading-sync-page" data-status={status}>
        {header}
        {status === "loading" && <p className="reading-sync-book type-label">Loading…</p>}
      </div>
    );
  const details = readingSyncDetails(offline ? null : listing.job);
  return (
    <div className="reading-sync-page reading-sync-details" data-state={offline ? "offline" : listing.job === undefined ? "loading" : "ready"}>
      {header}
      <p className="reading-sync-book type-label">{work.title}</p>
      {offline && (
        <Group label="Status">
          <Row label="No connection" />
        </Group>
      )}
      {details.rows.length > 0 && (
        <Group label="Reading sync">
          {details.rows.map((row) => (
            <Row key={row.label} label={row.label} value={row.value} />
          ))}
        </Group>
      )}
      {details.stages.length > 0 && (
        <Group caption="Stage times">
          {details.stages.map((row) => (
            <Row key={row.label} label={row.label} value={row.value} />
          ))}
        </Group>
      )}
      {details.warning && <p className="reading-sync-note">{details.warning}</p>}
      {details.olderEngine && (
        <Group caption="Older engine">
          <Row label={details.olderEngine} />
        </Group>
      )}
      {details.flags.length > 0 && (
        <Group caption="Flags">
          {details.flags.map((flag, index) => (
            <li key={index} className="reading-sync-flag type-label">
              {flag}
            </li>
          ))}
        </Group>
      )}
    </div>
  );
}
