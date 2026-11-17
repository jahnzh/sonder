/**
 * Now, Activity's first part, and the attention dot: one rule for both (#521, spec #513 "Now" and "The attention dot").
 *
 * `buildNow` is pure. It takes the server's answer (or none), this device's save entries (`deviceSaveEntries`), whether
 * the user is the administrator and whether there is a connection, and returns the four groups with their rows and
 * whether the dot is lit. The dot is lit exactly when Needs attention holds a row, so the dot and the list cannot
 * disagree. The Now screen and the shell's dot both call it; neither decides a group, a line or the dot itself.
 *
 * The server must not import this file: the production image copies only four files of `src/`.
 */
import type { DeviceSaveEntry } from "./device-saves";
import {
  downloadLine, ebookCheckLine, failedLine, finishedLine, readingSyncLine, serverCopyLine, seriesSearchLine,
  withFileCount, withReason, deviceSaveLine,
  type DownloadFacts, type EbookCheckFacts, type ReadingSyncJobFacts, type SeriesSearchFacts, type ServerCopyFacts,
} from "./status-lines";
import type { ActivityItem, ActivityItemAction, ActivityProcess, ActivityResponse } from "./types";

const HOUR = 60 * 60_000;
/** Finished work is listed this long (Finished today). */
export const FINISHED_TODAY_MS = 24 * HOUR;

/** The four groups, most urgent first. The ids are the tooltip keys of their captions (`tooltip-texts.ts`). */
export const NOW_GROUPS = [
  { id: "attention", title: "Needs attention" },
  { id: "progress", title: "In progress" },
  { id: "waiting", title: "Waiting" },
  { id: "finished", title: "Finished today" },
] as const;
export type NowGroupId = (typeof NOW_GROUPS)[number]["id"];
const RANK: Record<NowGroupId, number> = { attention: 0, progress: 1, waiting: 2, finished: 3 };

/** Which of a book's files a line is about, for its 20 px icon; `server` is the cover slot of a row that is not a book. */
export type NowIcon = "audiobook" | "ebook" | "reading-sync" | "server" | null;

/** What a row's one button does, and to what. */
export type NowButton =
  | { action: "pause" | "resume" | "retry"; source: "device"; recordingId: string; bookId: string }
  | { action: ActivityItemAction; source: "server"; itemId: string };

/**
 * What tapping a row opens. Until the Book page (S7) and the Reading sync page (S9) exist, the page opens today's
 * book dialog for both through one function of its own.
 */
export type NowOpens =
  | { to: "book"; workId: string; bookId: string | null }
  | { to: "reading-sync"; workId: string; bookId: string | null }
  | { to: "worker"; hostId: string }
  | { to: "server" }
  | null;

/** The kinds of entry a row can show, in the order a group prefers them (`ENTRY_ORDER`). */
export type NowEntryKind =
  | "download" | "server-copy" | "series-search" | "ebook-check" | "reading-sync" | "device-save"
  | "hardcover" | "backup" | "process";
const ENTRY_ORDER: NowEntryKind[] = [
  "download", "server-copy", "series-search", "ebook-check", "reading-sync", "device-save", "hardcover", "backup", "process",
];

export type NowRow = {
  /** Stable key: `work:<id>`, or the server item or process id for a row that has no work. */
  key: string;
  /** A book row (with a cover), or a row that is not a book (a process that is down, a Hardcover queue, a backup). */
  book: boolean;
  workId: string | null;
  bookId: string | null;
  title: string;
  /** The cover for a book row; null for a row that is not a book (its slot shows the server icon). */
  cover: string | null;
  /** The entry the row shows. */
  entry: NowEntryKind;
  icon: NowIcon;
  line: string;
  /** The line is in the failed colour. */
  failed: boolean;
  /** 0 to 1 for the accent bar while the entry moves; null for no bar. */
  progress: number | null;
  /** When the shown entry finished, for "how long ago" on the right in Finished today; null elsewhere. */
  finishedAt: number | null;
  button: NowButton | null;
  opens: NowOpens;
  /** The newest change of any of the row's entries, which orders the rows of a group. */
  changedAt: number;
};

export type NowGroup = { id: NowGroupId; title: string; rows: NowRow[] };

export type Now = {
  /** All four groups, most urgent first; a group with no row is still listed, with `rows` empty. */
  groups: NowGroup[];
  /** Needs attention holds a row. */
  dot: boolean;
  /** No group holds a row: the page shows "Nothing running". */
  empty: boolean;
  /** There is no connection: only the device's saves are listed, under the "No connection" card. */
  offline: boolean;
};

/** The facts of a book the device's saves need for their row. */
export type NowBook = { id: string; workId: string; title: string; cover?: string | null };

export type NowInput = {
  /** The server's answer, or null when there is none (not the administrator, not read yet, or unreachable). */
  activity: ActivityResponse | null;
  /** This device's save entries (`deviceSaveEntries`). */
  saves: readonly (DeviceSaveEntry & { audio?: boolean })[];
  /** The user's books, for the title and cover of a save's row. */
  books: readonly NowBook[];
  admin: boolean;
  /** The browser reports a connection and the last read of the server got an answer. */
  online: boolean;
  now: number;
};

/** One entry before rows are joined by work. */
type Entry = Omit<NowRow, "key" | "changedAt"> & { group: NowGroupId; changedAt: number };

const firstAction = (actions: readonly ActivityItemAction[]): ActivityItemAction | null =>
  (["retry", "resume", "discard"] as const).find((action) => actions.includes(action)) ?? null;

const ENTRY_OF: Record<ActivityItem["kind"], NowEntryKind> = {
  acquisition: "download",
  "server-copy": "server-copy",
  "series-acquisition": "series-search",
  "ebook-set": "ebook-check",
  alignment: "reading-sync",
  hardcover: "hardcover",
  backup: "backup",
};

const ICON_OF: Partial<Record<NowEntryKind, NowIcon>> = {
  download: "audiobook",
  "server-copy": "audiobook",
  "ebook-check": "ebook",
  "reading-sync": "reading-sync",
  "device-save": "audiobook",
};

/** The group of a server item: `attention` wins; null for an item Now does not list (an old failure, old finished work). */
function itemGroup(item: ActivityItem, now: number): NowGroupId | null {
  if (item.attention) return "attention";
  switch (item.state) {
    case "running":
      return "progress";
    case "queued":
    case "paused":
      return "waiting";
    case "done":
      return now - item.updatedAt <= FINISHED_TODAY_MS ? "finished" : null;
    default:
      // A failure older than seven days stays on the server but no longer asks for anything here.
      return null;
  }
}

/** The vocabulary line of a server item that is running or waiting (#494), with the facts its kind has. */
function movingLine(item: ActivityItem): string | null {
  const facts = item.facts;
  switch (facts.kind) {
    case "acquisition":
      return downloadLine({
        status: facts.status as DownloadFacts["status"], progress: item.progress, backend: facts.backend as DownloadFacts["backend"],
      });
    case "server-copy":
      return serverCopyLine({ status: facts.status as ServerCopyFacts["status"], progress: item.progress });
    case "series-acquisition":
      return seriesSearchLine({ status: facts.status as SeriesSearchFacts["status"], search: facts.search });
    case "ebook-set":
      return ebookCheckLine(
        (facts.status === "held" ? { status: "held", holdReason: facts.holdReason } : { status: facts.status }) as EbookCheckFacts,
      );
    case "alignment": {
      const line = readingSyncLine({
        hasEbook: true, hasRecording: true,
        job: {
          status: facts.status as ReadingSyncJobFacts["status"], outcome: facts.outcome as ReadingSyncJobFacts["outcome"],
          coverage: facts.coverage, progress: item.progress, wholeBook: facts.wholeBook, stage: facts.stage,
        },
      });
      return line && item.state === "running" ? withFileCount(line, facts.files) : line;
    }
    default:
      return null;
  }
}

/** The line of a finished server item: what became of its file, or the vocabulary's line for an outcome the table has not. */
function doneLine(item: ActivityItem): string | null {
  const facts = item.facts;
  switch (facts.kind) {
    case "acquisition":
      return finishedLine({ entry: "download", backend: facts.backend as DownloadFacts["backend"] });
    case "server-copy":
      return finishedLine({ entry: "server-copy" });
    case "series-acquisition":
      return finishedLine({ entry: "series-search", search: facts.search });
    case "ebook-set":
      return facts.status === "accepted" || facts.status === "rejected"
        ? finishedLine({ entry: "ebook-check", status: facts.status })
        : null;
    case "alignment":
      if ((facts.status === "ready" || facts.status === "cancelled") && !facts.outcome?.startsWith("language"))
        return finishedLine({ entry: "reading-sync", status: facts.status });
      if (facts.status === "partial" && facts.outcome !== "unsynced")
        return finishedLine({ entry: "reading-sync", status: "partial", coverage: facts.coverage });
      // "No text matched", "New reading sync not used", "Not available, English only": the vocabulary's own words.
      return movingLine(item);
    default:
      return null;
  }
}

function serverEntry(item: ActivityItem, now: number): Entry | null {
  const group = itemGroup(item, now);
  if (!group) return null;
  const entry = ENTRY_OF[item.kind];
  const failed = item.state === "failed";
  // A Hardcover queue and a backup are not books: they appear only when they need attention.
  const notBook = entry === "hardcover" || entry === "backup";
  if (notBook && group !== "attention") return null;
  let line: string | null;
  if (notBook) line = item.error ?? item.stuck?.reason ?? item.detail;
  else if (failed) line = failedLine({ entry: entry as "download" });
  else if (item.state === "done") line = doneLine(item);
  else line = movingLine(item);
  // A finished series search for the audiobook has no line: the download it starts takes over the row.
  if (line === null && entry === "series-search" && item.state === "done") return null;
  if (!notBook && item.stuck) line = withReason(line ?? item.detail ?? "", item.stuck.reason);
  const action = firstAction(item.actions);
  const syncOpen = entry === "reading-sync" && item.state !== "done";
  return {
    group,
    book: !notBook,
    workId: item.workId,
    bookId: item.bookId,
    title: item.title,
    cover: notBook ? null : item.cover,
    entry,
    icon: notBook ? "server" : ICON_OF[entry] ?? null,
    line: line ?? item.detail ?? "",
    failed: failed || notBook,
    progress: group === "progress" && !item.stuck ? item.progress : null,
    finishedAt: group === "finished" ? item.updatedAt : null,
    button: action ? { action, source: "server", itemId: item.id } : null,
    opens: notBook
      ? { to: "server" }
      : item.workId
        ? { to: syncOpen ? "reading-sync" : "book", workId: item.workId, bookId: item.bookId }
        : null,
    changedAt: item.updatedAt,
  };
}

/** A background process that is down, as a row that is not a book. A worker switched off is never down. */
function processEntry(process: ActivityProcess, checkedAt: number): Entry | null {
  if (process.health !== "down" || process.notTracked || process.host?.disabled) return null;
  return {
    group: "attention",
    book: false,
    workId: null,
    bookId: null,
    title: process.label,
    cover: null,
    entry: "process",
    icon: "server",
    line: process.reason ?? "Down",
    failed: true,
    progress: null,
    finishedAt: null,
    button: null,
    opens: process.host ? { to: "worker", hostId: process.host.hostId } : { to: "server" },
    changedAt: process.since ?? checkedAt,
  };
}

function saveEntry(save: DeviceSaveEntry, books: readonly NowBook[], online: boolean, now: number): Entry | null {
  const book = books.find((b) => b.id === save.bookId) ?? books.find((b) => b.workId === save.workId);
  const base = {
    book: true, workId: save.workId, bookId: save.bookId, title: book?.title ?? "", cover: book?.cover ?? null,
    entry: "device-save" as const, icon: "audiobook" as const, finishedAt: null,
    opens: { to: "book" as const, workId: save.workId, bookId: save.bookId || null },
    changedAt: Math.max(save.finishedAt ?? 0, save.startedAt ?? 0),
  };
  const target = { source: "device" as const, recordingId: save.recordingId, bookId: save.bookId };
  const notComplete = failedLine({ entry: "device-save", filesDone: save.filesDone, filesTotal: save.filesTotal });
  if (save.state === "complete") {
    if (!save.finishedAt || now - save.finishedAt > FINISHED_TODAY_MS) return null;
    return {
      ...base, group: "finished", line: finishedLine({ entry: "device-save", size: save.size }) ?? "",
      // A finished save of the whole book has no icon.
      icon: null, failed: false, progress: null, finishedAt: save.finishedAt, button: null,
    };
  }
  if (save.state === "not-complete" && save.why === "failed")
    return { ...base, group: "attention", line: notComplete, failed: true, progress: null, button: { action: "retry", ...target } };
  // Without a connection nothing is saved: a running save waits as not complete, with no bar and no button.
  if (save.state === "saving" && online) {
    const line = deviceSaveLine({ keep: false, saving: true, filesTotal: save.filesTotal, filesSaved: save.filesDone, size: save.size });
    return { ...base, group: "progress", line: line ?? notComplete, failed: false, progress: save.progress, button: { action: "pause", ...target } };
  }
  return { ...base, group: "waiting", line: notComplete, failed: false, progress: null, button: online ? { action: "resume", ...target } : null };
}

/** The entry a row shows: the first by `ENTRY_ORDER` among its most urgent group's entries; in Finished today the newest. */
function shownEntry(entries: Entry[]): Entry {
  const group = entries.reduce((best, entry) => (RANK[entry.group] < RANK[best] ? entry.group : best), entries[0].group);
  const mine = entries.filter((entry) => entry.group === group);
  if (group === "finished") return mine.reduce((a, b) => ((b.finishedAt ?? 0) > (a.finishedAt ?? 0) ? b : a));
  return mine.reduce((a, b) => (ENTRY_ORDER.indexOf(b.entry) < ENTRY_ORDER.indexOf(a.entry) ? b : a));
}

export function buildNow({ activity, saves, books, admin, online, now }: NowInput): Now {
  const entries: { key: string; entry: Entry }[] = [];
  // The server's work is the administrator's, and only while there is a connection: a stale answer never reads as live.
  if (admin && online && activity) {
    for (const item of activity.items) {
      const entry = serverEntry(item, now);
      if (entry) entries.push({ key: entry.book && entry.workId ? `work:${entry.workId}` : item.id, entry });
    }
    for (const process of activity.processes) {
      const entry = processEntry(process, activity.checkedAt);
      if (entry) entries.push({ key: process.id, entry });
    }
  }
  // Only audiobook saves are entries on Now; an ebook kept for reading offline is This device's.
  for (const save of saves) {
    if (save.audio === false || !save.recordingId) continue;
    const entry = saveEntry(save, books, online, now);
    if (entry) entries.push({ key: `work:${save.workId}`, entry });
  }

  const byKey = new Map<string, Entry[]>();
  for (const { key, entry } of entries) byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  const rows: (NowRow & { group: NowGroupId })[] = [];
  for (const [key, joined] of byKey) {
    const { group, ...shown } = shownEntry(joined);
    // A save's row has no title of its own when the device does not know the book: take the server's.
    const title = shown.title || joined.find((entry) => entry.title)?.title || "";
    const cover = shown.book ? shown.cover ?? joined.find((entry) => entry.cover)?.cover ?? null : null;
    const bookId = shown.bookId ?? joined.find((entry) => entry.bookId)?.bookId ?? null;
    const opens = shown.opens && shown.opens.to !== "worker" && shown.opens.to !== "server" ? { ...shown.opens, bookId: shown.opens.bookId ?? bookId } : shown.opens;
    rows.push({
      ...shown, key, group, title, cover, bookId, opens,
      changedAt: Math.max(...joined.map((entry) => entry.changedAt)),
    });
  }
  const groups = NOW_GROUPS.map(({ id, title }) => ({
    id,
    title,
    rows: rows
      .filter((row) => row.group === id)
      .sort((a, b) => b.changedAt - a.changedAt || a.key.localeCompare(b.key))
      .map(({ group: _group, ...row }) => row),
  }));
  return {
    groups,
    dot: groups[0].rows.length > 0,
    empty: groups.every((group) => group.rows.length === 0),
    offline: !online,
  };
}
