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
  /** Opens a work's Book page. */
  book: (workId: string, bookId: string | null) => void;
  /** Opens a work's Reading sync page (#540). */
  sync: (workId: string) => void;
  /** Opens a reading sync worker's page. */
  worker: (hostId: string) => void;
  /** Opens Activity's Server. */
  server: () => void;
};

/**
 * What a row opens: a book its Book page, a reading sync that is running, waiting or stopped its Reading sync page
 * (#540), a worker its page, the rest Server.
 */
export function openNowRow(opens: NowOpens, open: NowOpeners): void {
  if (!opens) return;
  switch (opens.to) {
    case "book":
      return open.book(opens.workId, opens.bookId);
    case "reading-sync":
      return open.sync(opens.workId);
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
  /** Sends Retry, Resume, Discard or Cancel of a server item; rejects with the server's reason. */
  onServer: (action: Extract<NowButton, { source: "server" }>["action"], itemId: string) => Promise<void>;
  /** Pauses, resumes or retries a save to this device. */
  onDevice: (
    action: Extract<NowButton, { source: "device" }>["action"],
    recordingId: string,
    bookId: string,
    /** A kept book (#552): its work, whose Keep record Pause and Resume go through. */
    kept?: { workId: string } | null,
  ) => void;
};

const MARK: Partial<Record<NonNullable<NowIcon>, FileKind>> = { audiobook: "audiobook", ebook: "ebook", "reading-sync": "sync" };
const LABEL = { pause: "Pause", resume: "Resume", retry: "Retry", discard: "Discard", cancel: "Cancel" } as const;

/** What a server action that removes something asks, once, in place before it is sent (Discard; Cancel, #716). */
const ASK = {
  discard: { question: (title: string) => `Discard “${title}” for good? It is not sent again.`, dismiss: "Cancel", confirm: "Discard" },
  cancel: {
    question: (title: string) => `Cancel the download of “${title}”? Its torrent and partial files are removed. Other copies of the book stay.`,
    dismiss: "Keep",
    confirm: "Cancel download",
  },
} as const;
type Asked = keyof typeof ASK;

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
  const [asking, setAsking] = useState<{ action: Asked; itemId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const buttons = [row.button, row.cancel].filter((button): button is NowButton => !!button);
  const nameOf = (button: NowButton) =>
    button.source === "device" && button.action === "pause" ? `Pause saving ${row.title}` : `${LABEL[button.action]} ${row.title}`;
  const send = (action: Extract<NowButton, { source: "server" }>["action"], itemId: string) => {
    setBusy(true);
    setFailure(null);
    onServer(action, itemId)
      .then(() => setAsking(null))
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  const press = (button: NowButton) => {
    if (button.source === "device") {
      setFailure(null);
      return onDevice(button.action, button.recordingId, button.bookId, button.keep && button.workId ? { workId: button.workId } : null);
    }
    // Discard and Cancel remove something: they ask once, in place.
    if (button.action === "discard" || button.action === "cancel") {
      const action = button.action;
      return setAsking((shown) => (shown?.action === action ? null : { action, itemId: button.itemId }));
    }
    send(button.action, button.itemId);
  };
  const mark = row.icon ? MARK[row.icon] : undefined;
  const ask = asking ? ASK[asking.action] : null;
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
          buttons.length ? (
            <span className="activity-now-actions">
              {buttons.map((button) => (
                <Button
                  key={button.action}
                  aria-label={nameOf(button)}
                  aria-expanded={button.action === "discard" || button.action === "cancel" ? asking?.action === button.action : undefined}
                  disabled={busy}
                  onClick={() => press(button)}
                >
                  {LABEL[button.action]}
                </Button>
              ))}
            </span>
          ) : undefined
        }
      />
      {asking && ask && (
        <li className="activity-now-confirm" role="group" aria-label={`${LABEL[asking.action]} ${row.title}`}>
          <span className="type-body">{ask.question(row.title)}</span>
          <span className="activity-now-confirm-buttons">
            <Button onClick={() => { setAsking(null); setFailure(null); }}>{ask.dismiss}</Button>
            <Button className="activity-now-discard" disabled={busy} onClick={() => send(asking.action, asking.itemId)}>
              {ask.confirm}
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
