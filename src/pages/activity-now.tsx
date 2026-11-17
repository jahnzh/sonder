// Activity's Now (#522, spec #513 "Now"; boards Activity.dc.html, ActivityEmpty.dc.html, ActivityOffline.dc.html,
// ActivityMember.dc.html, ActivityFailedSave.dc.html, DesktopActivity.dc.html): every book that has work going on,
// one Book row each, in four groups. What the groups hold, each row's line, its button and what it opens are decided
// by Now's one rule (`buildNow` in src/activity-now.ts), which the shell's dot reads too; this file only draws it.
import { useState } from "react";
import { AlertCircle, Server, WifiOff } from "lucide-react";
import { Group } from "../parts/Group";
import { BookRow } from "../parts/BookRow";
import { Button } from "../parts/Button";
import { InfoMark } from "../parts/Tooltip";
import type { FileKind } from "../parts/icons";
import { tip } from "../tooltip-texts";
import { finishedAgo } from "../status-lines";
import type { Now, NowButton, NowIcon, NowOpens, NowRow } from "../activity-now";
import "./activity-now.css";

export type NowOpeners = {
  /** Opens a work's book: today's book dialog until the Book page (S7) exists. */
  book: (workId: string, bookId: string | null) => void;
  /** Opens a reading sync worker's page. */
  worker: (hostId: string) => void;
  /** Opens Activity's Server. */
  server: () => void;
};

/**
 * What a row opens. The one function of the page that the Book page (S7) and the Reading sync page (S9) each change:
 * until they exist, a book and its reading sync both open today's book dialog for the work.
 */
export function openNowRow(opens: NowOpens, open: NowOpeners): void {
  if (!opens) return;
  switch (opens.to) {
    case "book":
    case "reading-sync":
      return open.book(opens.workId, opens.bookId);
    case "worker":
      return open.worker(opens.hostId);
    case "server":
      return open.server();
  }
}

export type ActivityNowProps = {
  /** Now's groups, from the shell's one call of `buildNow`. */
  now: Now;
  /** The server's message when its last read was answered with an error (administrator); null otherwise. */
  serverError: string | null;
  open: NowOpeners;
  /** Sends Retry, Resume or Discard of a server item; rejects with the server's reason. */
  onServer: (action: Extract<NowButton, { source: "server" }>["action"], itemId: string) => Promise<void>;
  /** Pauses, resumes or retries a save to this device. */
  onDevice: (action: Extract<NowButton, { source: "device" }>["action"], recordingId: string, bookId: string) => void;
};

const MARK: Partial<Record<NonNullable<NowIcon>, FileKind>> = { audiobook: "audiobook", ebook: "ebook", "reading-sync": "sync" };
const LABEL = { pause: "Pause", resume: "Resume", retry: "Retry", discard: "Discard" } as const;

/** A card of one or two lines in a Group: Nothing running, No connection, the server's message. */
function Note({ title, text, icon, alert }: { title: string; text?: string; icon?: "offline" | "error"; alert?: boolean }) {
  return (
    <li className="activity-now-note" role={alert ? "alert" : undefined}>
      {icon && (
        <span className="activity-now-note-icon" aria-hidden="true">
          {icon === "offline" ? <WifiOff size={20} /> : <AlertCircle size={20} />}
        </span>
      )}
      <span className="activity-now-note-text">
        <span className="type-body">{title}</span>
        {text && <span className="type-label activity-now-note-line">{text}</span>}
      </span>
    </li>
  );
}

function Row({ row, at, open, onServer, onDevice }: { row: NowRow; at: number } & Omit<ActivityNowProps, "now" | "serverError">) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const button = row.button;
  const name = button ? (button.source === "device" && button.action === "pause" ? `Pause saving ${row.title}` : `${LABEL[button.action]} ${row.title}`) : "";
  const send = (action: Extract<NowButton, { source: "server" }>["action"], itemId: string) => {
    setBusy(true);
    setFailure(null);
    onServer(action, itemId)
      .then(() => setAsking(false))
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  const press = () => {
    if (!button) return;
    if (button.source === "device") {
      setFailure(null);
      return onDevice(button.action, button.recordingId, button.bookId);
    }
    // Discard asks once, in place.
    if (button.action === "discard") return setAsking((shown) => !shown);
    send(button.action, button.itemId);
  };
  const mark = row.icon ? MARK[row.icon] : undefined;
  return (
    <>
      <BookRow
        title={row.title}
        status={row.line}
        cover={row.book ? row.cover : null}
        coverIcon={row.book ? undefined : <Server size={20} />}
        marks={mark ? [mark] : []}
        progress={row.progress}
        failed={row.failed}
        trailing={row.finishedAt !== null ? finishedAgo(row.finishedAt, at) : null}
        onClick={row.opens ? () => openNowRow(row.opens, open) : undefined}
        action={
          button ? (
            <Button aria-label={name} aria-expanded={button.action === "discard" ? asking : undefined} disabled={busy} onClick={press}>
              {LABEL[button.action]}
            </Button>
          ) : undefined
        }
      />
      {asking && button?.source === "server" && (
        <li className="activity-now-confirm" role="group" aria-label={`Discard ${row.title}`}>
          <span className="type-body">{`Discard “${row.title}” for good? It is not sent again.`}</span>
          <span className="activity-now-confirm-buttons">
            <Button onClick={() => { setAsking(false); setFailure(null); }}>Cancel</Button>
            <Button className="activity-now-discard" disabled={busy} onClick={() => send("discard", button.itemId)}>
              Discard
            </Button>
          </span>
        </li>
      )}
      {failure && (
        <li className="activity-now-failure type-label" role="alert">
          {failure}
        </li>
      )}
    </>
  );
}

export function ActivityNow({ now, serverError, open, onServer, onDevice }: ActivityNowProps) {
  const at = Date.now();
  const groups = now.groups.filter((group) => group.rows.length > 0);
  return (
    <div className="activity-now" data-testid="activity-now">
      <div className="activity-now-list">
        {now.offline ? (
          <Group label="Connection">
            <Note icon="offline" title="No connection" text="Work on the server shows again when the connection is back." />
          </Group>
        ) : serverError ? (
          // A read answered with an error: the server's message in the card's place until the next read succeeds.
          <Group label="Server">
            <Note icon="error" title={serverError} alert />
          </Group>
        ) : now.empty ? (
          <Group label="Now">
            <Note title="Nothing running" />
          </Group>
        ) : null}
        {groups.map((group) => (
          <Group key={group.id} caption={group.title} info={<InfoMark name={group.title} text={tip(group.id)} />}>
            {group.rows.map((row) => (
              <Row key={row.key} row={row} at={at} open={open} onServer={onServer} onDevice={onDevice} />
            ))}
          </Group>
        ))}
      </div>
    </div>
  );
}
