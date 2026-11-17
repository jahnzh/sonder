import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  BookOpen,
  Check,
  Cloud,
  ExternalLink,
  Headphones,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  Settings,
  Unlink,
  X,
  ArrowRight,
} from "lucide-react";
import { api, localDB, duration, isAdmin, userId } from "../lib";
import { accountAnswer } from "../account-answer";
import type { Book, HardcoverState, Progress } from "../types";
import { workMediaStateLabel } from "../work-media-state";
import { savedPreferencesToFollow, type SyncPreferences } from "../hardcover-sync-draft";
import { Dialog } from "./ui/dialog";
import { usePlayer } from "../player";
type Notify = (text: string, error?: boolean) => void;
export function hardcoverChanged() {
  window.dispatchEvent(new Event("sonder:hardcover-changed"));
}
/**
 * The state last read, for the account it was read for. A page shown again (Back to the Library) starts from it
 * instead of from "not connected", so it has its height at once and a restored scroll position stays on the
 * book it was on; the fresh state replaces it when it arrives.
 */
const lastState = accountAnswer<HardcoverState>(userId);
function useHardcover() {
  const lastSeenSync = useRef(0);
  const [state, setState] = useState<HardcoverState | null>(() => lastState.kept() ?? null);
  const refresh = useCallback(async () => {
    try {
      const answer = await lastState.read(() => api<HardcoverState>("/hardcover"));
      // Asked as an account that is no longer signed in: not this account's state, nor its device's copy.
      if (!answer) return;
      const next = answer.value;
      setState(next);
      if (next.lastSync !== lastSeenSync.current) {
        lastSeenSync.current = next.lastSync;
        window.dispatchEvent(new Event("sonder:library-changed"));
      }
      await localDB.preferences.put({ key: "hardcover", value: next });
    } catch {
      const cached = await localDB.preferences.get("hardcover");
      if (cached?.value) setState(cached.value as HardcoverState);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (navigator.onLine && document.visibilityState === "visible")
        void refresh();
    }, 60000);
    const changed = () => void refresh();
    window.addEventListener("sonder:hardcover-changed", changed);
    window.addEventListener("online", changed);
    return () => {
      clearInterval(timer);
      window.removeEventListener("sonder:hardcover-changed", changed);
      window.removeEventListener("online", changed);
    };
  }, [refresh]);
  return { state, refresh };
}
function lastSync(time: number) {
  return time
    ? new Date(time).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not synced yet";
}
export type HardcoverFilter = { shelf: string; list: string };
export function HardcoverLibraryFilters({
  filter,
  onFilter,
  onSettings,
  onChanged,
  notify,
}: {
  filter: HardcoverFilter;
  onFilter: (v: HardcoverFilter) => void;
  onSettings: () => void;
  onChanged: () => void;
  notify: Notify;
}) {
  const { state, refresh } = useHardcover();
  const [busy, setBusy] = useState(false);
  const sync = async () => {
    setBusy(true);
    try {
      const result = await api<{ imported: number; pending: number }>(
        "/hardcover/sync",
        { method: "POST" },
      );
      notify(
        result.pending
          ? `Library synced. ${result.pending} changes are still queued.`
          : `Hardcover synced${result.imported ? ` · ${result.imported} new books` : ""}.`,
      );
      hardcoverChanged();
      onChanged();
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  if (!state?.configured)
    return (
      <div className="hardcover-connect-callout">
        <span>
          <BookOpen size={16} /> Your books, together with Hardcover.
        </span>
        <button onClick={onSettings}>
          Connect library <ArrowRight size={13} />
        </button>
      </div>
    );
  if (state.mode === "off")
    return (
      <div className="hardcover-connect-callout">
        <span>
          <BookOpen size={16} /> Hardcover is connected. Library sync is off.
        </span>
        <button onClick={onSettings}>
          Set up sync <ArrowRight size={13} />
        </button>
      </div>
    );
  return (
    <div className="hardcover-library">
      <div className="hardcover-library-meta">
        <span>
          <BookOpen size={15} /> Hardcover{" "}
          {state.username && <strong>@{state.username}</strong>}
        </span>
        <span>
          {state.pending
            ? `${state.pending} changes queued`
            : lastSync(state.lastSync)}
        </span>
      </div>
      <div className="hardcover-library-controls">
        <label>
          <span className="sr-only">Hardcover shelf</span>
          <select
            aria-label="Hardcover shelf"
            value={filter.shelf}
            onChange={(e) => onFilter({ ...filter, shelf: e.target.value })}
          >
            <option value="all">All reading shelves</option>
            <option value="linked">Linked to Hardcover</option>
            {state.shelves.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Hardcover list</span>
          <select
            aria-label="Hardcover list"
            value={filter.list}
            onChange={(e) => onFilter({ ...filter, list: e.target.value })}
          >
            <option value="all">All Hardcover lists</option>
            {state.lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} · {l.count}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button subtle"
          disabled={busy || !navigator.onLine}
          onClick={() => void sync()}
        >
          {busy ? (
            <Loader2 className="spin" size={14} />
          ) : (
            <RefreshCw size={14} />
          )}{" "}
          Sync now
        </button>
        {(filter.shelf !== "all" || filter.list !== "all") && (
          <button
            className="icon-button"
            onClick={() => onFilter({ shelf: "all", list: "all" })}
            aria-label="Clear Hardcover filters"
          >
            <X size={15} />
          </button>
        )}
      </div>
      {state.lastError && (
        <p className="hardcover-inline-warning">{state.lastError}</p>
      )}
    </div>
  );
}
export function HardcoverSyncSettings({
  configured,
  notify,
}: {
  configured: boolean;
  notify: Notify;
}) {
  const { state, refresh } = useHardcover();
  const [mode, setMode] = useState<HardcoverState["mode"]>("off");
  const [lists, setLists] = useState(true);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    void refresh();
  }, [configured, refresh]);
  // The saved preferences the form last followed. A refresh that returns the same ones leaves the form alone, so
  // an unsaved pick survives it (#422); the effect never writes the draft, whose value here may predate the pick.
  const followed = useRef<SyncPreferences | null>(null);
  useEffect(() => {
    if (!state) return;
    const saved = { mode: state.mode, syncLists: state.syncLists };
    const follow = savedPreferencesToFollow(followed.current, saved);
    followed.current = saved;
    if (!follow) return;
    setMode(follow.mode);
    setLists(follow.syncLists);
  }, [state]);
  const run = async (action: "save" | "sync" | "test") => {
    setBusy(action);
    try {
      if (action === "save") {
        await api("/hardcover/config", {
          method: "PATCH",
          body: JSON.stringify({ mode, syncLists: lists }),
        });
        notify("Hardcover sync preferences saved.");
      } else if (action === "test") {
        const account = await api<{ username: string | null }>(
          "/hardcover/test",
          { method: "POST" },
        );
        notify(
          account.username
            ? `Connected to @${account.username}.`
            : "Hardcover account connected.",
        );
      } else {
        const result = await api<{
          imported: number;
          matched: number;
          progress: number;
          pending: number;
        }>("/hardcover/sync", { method: "POST" });
        notify(
          `Synced ${result.imported} new books, ${result.matched} matches, and ${result.progress} reading positions.${result.pending ? ` ${result.pending} changes remain queued.` : ""}`,
        );
      }
      hardcoverChanged();
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
      await refresh();
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="settings-section hardcover-sync-settings">
      <div className="settings-section-heading">
        <span className="settings-section-icon lilac">
          <BookOpen size={20} />
        </span>
        <div>
          <h2>Hardcover library & progress</h2>
        </div>
        {state?.username && (
          <span className="connection-tag connected">@{state.username}</span>
        )}
      </div>
      <p className="hardcover-help">
        Add your Hardcover token above, save changes, then choose how your
        library stays in step. Imports preserve local audio, downloads, and
        recording IDs.
      </p>
      <label>
        Library sync
        <select
          aria-label="Hardcover sync mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as HardcoverState["mode"])}
          disabled={!configured || !state}
        >
          <option value="off">Off · catalog and matching only</option>
          <option value="import">
            Import only · bring Hardcover shelves and progress here
          </option>
          <option value="two-way">
            Two-way · sync shelves and reading progress both ways
          </option>
        </select>
      </label>
      <label className="hardcover-checkbox">
        <input
          type="checkbox"
          checked={lists}
          onChange={(e) => setLists(e.target.checked)}
          disabled={!configured || !state}
        />
        <span>Include my Hardcover lists</span>
      </label>
      <div className="hardcover-mode-description">
        {mode === "two-way"
          ? "Listening position is saved locally first, then sent to Hardcover about once a minute. Changes to shelves and lists in Sonder update your Hardcover account."
          : mode === "import"
            ? "Import mode brings reading statuses, lists, and available Hardcover progress into Sonder. It makes no changes to your Hardcover account."
            : "Sync is off. Catalog search and book matching remain available. Choose a sync mode to connect your reading library."}{" "}
        Imported books without a recording stay on the shelf with a “Find audio”
        action.
      </div>
      <details className="hardcover-permissions">
        <summary>Token permissions for library sync</summary>
        <p>
          Enable <code>read:catalog</code>, <code>read:library</code>, and{" "}
          <code>read:me:content</code>. Two-way shelves and progress also need{" "}
          <code>write:library</code>. Lists need <code>read:lists</code> and, to
          edit them here, <code>write:lists</code>.
        </p>
      </details>
      <div className="hardcover-sync-actions">
        <button
          className="button primary"
          disabled={!configured || !state || !!busy}
          onClick={() => void run("save")}
        >
          {busy === "save" ? (
            <Loader2 className="spin" size={15} />
          ) : (
            <Check size={15} />
          )}{" "}
          Save sync preferences
        </button>
        <button
          className="button subtle"
          disabled={!configured || !!busy}
          onClick={() => void run("test")}
        >
          {busy === "test" ? (
            <Loader2 className="spin" size={15} />
          ) : (
            <Link2 size={15} />
          )}{" "}
          Test account
        </button>
        <button
          className="button subtle"
          disabled={!configured || !!busy || state?.mode === "off"}
          onClick={() => void run("sync")}
        >
          {busy === "sync" ? (
            <Loader2 className="spin" size={15} />
          ) : (
            <RefreshCw size={15} />
          )}{" "}
          Sync now
        </button>
      </div>
      <div className="hardcover-sync-summary">
        <span>{lastSync(state?.lastSync || 0)}</span>
        <span>
          {state?.linked || 0} linked works · {state?.pending || 0} queued
          changes
        </span>
      </div>
      {state?.lastError && (
        <p className="inline-error" role="alert">
          {state.lastError}
        </p>
      )}
      {state?.listWarning && (
        <p className="hardcover-inline-warning">
          Lists: {state.listWarning} The last successful list snapshot is kept.
        </p>
      )}
    </section>
  );
}
type EditionOptions = {
  selectedEditionId: number | null;
  localDuration: number;
  durationsKnown: boolean;
  editions: { id: number; duration: number; narrators: string[] }[];
};
export function HardcoverBookTools({
  book,
  onChanged,
  onSettings,
  onOpenSeries,
  notify,
}: {
  book: Book;
  onChanged: () => void;
  onSettings: () => void;
  onOpenSeries: (id: number) => void;
  notify: Notify;
}) {
  const { state, refresh } = useHardcover();
  const player = usePlayer();
  const [matching, setMatching] = useState(false);
  const [query, setQuery] = useState(`${book.title} ${book.author}`);
  const [matches, setMatches] = useState<
    {
      id: number;
      title: string;
      author_names?: string[];
      image?: { url: string };
    }[]
  >([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [options, setOptions] = useState<EditionOptions | null>(null);
  const [listDraft, setListDraft] = useState<Record<number, boolean>>({});
  const listSignature = book.hardcover?.listIds.join(",") || "";
  useEffect(() => setListDraft({}), [book.id, listSignature]);
  useEffect(() => {
    setQuery(`${book.title} ${book.author}`);
    setOptions(null);
  }, [book.id, book.title, book.author, book.hardcover?.id]);
  const changed = () => {
    hardcoverChanged();
    onChanged();
    void refresh();
  };
  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy("search");
    setError("");
    try {
      const result = await api<
        | {
            hits?: {
              document: {
                id: number;
                title: string;
                author_names?: string[];
                image?: { url: string };
              };
            }[];
          }
        | string
      >("/discover/hardcover?q=" + encodeURIComponent(query));
      const data = typeof result === "string" ? JSON.parse(result) : result;
      setMatches(
        (data.hits || []).map((h: { document: (typeof matches)[number] }) => ({
          ...h.document,
          id: Number(h.document.id),
        })),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const link = async (id: number) => {
    setBusy(String(id));
    setError("");
    try {
      await api("/hardcover/books", {
        method: "POST",
        body: JSON.stringify({ id, workId: book.workId }),
      });
      changed();
      setMatching(false);
      notify("This recording is linked to its Hardcover book.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const addSeries = async (seriesName: string, seriesId?: number) => {
    if (!seriesName) return;
    if (seriesId) { onOpenSeries(seriesId); return; }
    setBusy(`series:${seriesName}`);
    setError("");
    try {
      const memberships = await api<{ id: number; name: string }[]>(`/hardcover/books/${book.hardcover!.id}/series`);
      const matches = memberships.filter((item) => item.name === seriesName);
      if (matches.length !== 1) throw new Error("This series could not be identified uniquely. Search for it in Discover.");
      onOpenSeries(matches[0].id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const retryMedia = async () => {
    setBusy("retry-media");
    setError("");
    try {
      await api(`/works/${book.workId}/media/retry`, { method: "POST" });
      changed();
      notify("Download retry started.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const setShelf = async (statusId: number) => {
    setBusy("shelf");
    try {
      await api("/hardcover/shelf", {
        method: "PATCH",
        body: JSON.stringify({ workId: book.workId, statusId }),
      });
      changed();
      notify("Shelf change saved. Hardcover will sync in the background.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };
  const setList = async (id: number, included: boolean) => {
    setListDraft((current) => ({ ...current, [id]: included }));
    setBusy(`list-${id}`);
    try {
      await api(`/hardcover/lists/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ workId: book.workId, included }),
      });
      changed();
      notify(
        included
          ? "Book added to your Hardcover list."
          : "Book removed from this Hardcover list.",
      );
    } catch (e) {
      setListDraft((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };
  const resume = async () => {
    setBusy("resume");
    try {
      const previous = (await localDB.progress.get(book.recordingId)) || book.progress || null;
      const result = await api<{ progress: Progress }>(
        "/hardcover/progress/pull",
        {
          method: "POST",
          body: JSON.stringify({
            workId: book.workId,
            recordingId: book.recordingId,
          }),
        },
      );
      if (result.progress) {
        await localDB.progress.put({ ...result.progress, pending: false });
        const track = book.tracks.find((t) => t.id === result.progress.trackId);
        if (track)
          await player.play(
            { ...book, progress: result.progress },
            track,
            result.progress.position,
            { kind: "hardcover", previous },
          );
      }
      changed();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };
  const loadEditions = async () => {
    setBusy("editions");
    try {
      setOptions(
        await api<EditionOptions>(
          "/hardcover/editions?" +
            new URLSearchParams({
              workId: book.workId,
              recordingId: book.recordingId,
            }),
        ),
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };
  const chooseEdition = async (editionId: number | null) => {
    setBusy("edition");
    try {
      await api("/hardcover/edition", {
        method: "PATCH",
        body: JSON.stringify({
          workId: book.workId,
          recordingId: book.recordingId,
          editionId,
        }),
      });
      setOptions((o) => (o ? { ...o, selectedEditionId: editionId } : o));
      notify("Recording edition saved.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <section className="hardcover-book-tools">
        <div className="hardcover-book-heading">
          <span>
            <BookOpen size={18} /> Hardcover
          </span>
          {book.hardcover && (
            <span className="hardcover-linked">
              <Check size={12} /> Linked
            </span>
          )}
        </div>
        {!state?.configured ? (
          <div className="hardcover-unlinked">
            <button className="button subtle" onClick={onSettings}>
              Connect Hardcover <ArrowRight size={14} />
            </button>
          </div>
        ) : !book.hardcover ? (
          // The work → Hardcover match is shared by every user, so only the admin sets it.
          <div className="hardcover-unlinked">
            <p>
              {isAdmin()
                ? "Match this recording to its book to sync reading status and progress."
                : "Not matched on Hardcover yet. The administrator can match it."}
            </p>
            {isAdmin() && <button
              className="button subtle"
              onClick={() => {
                setMatching(true);
                setMatches([]);
              }}
            >
              Match on Hardcover <Search size={14} />
            </button>}
          </div>
        ) : (
          <>
            <div className="hardcover-book-summary">
              <label>
                Reading shelf
                <select
                  aria-label="Book Hardcover shelf"
                  value={book.hardcover.statusId || ""}
                  disabled={state.mode !== "two-way" || !!busy}
                  onChange={(e) => void setShelf(Number(e.target.value))}
                >
                  <option value="" disabled>
                    Not on a reading shelf
                  </option>
                  {state.shelves.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="hardcover-progress-summary">
                <span>
                  {book.hardcover.progressFraction === null
                    ? "No synced reading position"
                    : `${Math.round(book.hardcover.progressFraction * 100)}% reading progress`}
                </span>
                <small>
                  {book.hardcover.pending || book.hardcover.progressPending
                    ? "Changes saved · waiting to sync"
                    : lastSync(state.lastSync)}
                </small>
              </div>
            </div>
            {state.mode !== "two-way" && (
              <p className="hardcover-help">
                Enable two-way sync in Settings to update shelves, lists, and
                reading progress from Sonder.
              </p>
            )}
            {book.hardcover.series.length > 0 && (
              <div className="hardcover-series">
                {book.hardcover.series.map((s) => (
                  <span key={s.name}>
                    {s.name}
                    {s.position !== null ? ` · #${s.position}` : ""}
                    <button
                      type="button"
                      className="button subtle"
                      disabled={!!busy}
                      onClick={() => void addSeries(s.name, s.id)}
                    >
                      {busy === `series:${s.name}` ? (
                        <Loader2 className="spin" size={14} />
                      ) : (
                        <BookOpen size={14} />
                      )}{" "}
                      Add series
                    </button>
                  </span>
                ))}
              </div>
            )}
            {book.mediaState && (
              <div className="hardcover-media-state">
                <span>{workMediaStateLabel(book.mediaState)}</span>
                {book.mediaState.state === "failed" && (
                  <button
                    type="button"
                    className="button subtle"
                    disabled={!!busy}
                    onClick={() => void retryMedia()}
                  >
                    {busy === "retry-media" ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <RefreshCw size={14} />
                    )}{" "}
                    Retry
                  </button>
                )}
              </div>
            )}
            {state.lists.length > 0 && (
              <div className="hardcover-book-lists">
                <span>Your lists</span>
                {state.lists.map((l) => (
                  <label className="hardcover-checkbox" key={l.id}>
                    <input
                      type="checkbox"
                      checked={
                        listDraft[l.id] ??
                        book.hardcover!.listIds.includes(l.id)
                      }
                      disabled={state.mode !== "two-way" || !!busy}
                      onChange={(e) => void setList(l.id, e.target.checked)}
                    />
                    <span>{l.name}</span>
                    {busy === `list-${l.id}` && (
                      <Loader2 className="spin" size={13} />
                    )}
                  </label>
                ))}
              </div>
            )}
            <div className="hardcover-book-actions">
              {book.tracks.length > 0 && (
                <>
                  <button
                    className="button subtle"
                    disabled={!!busy || state.mode === "off"}
                    onClick={() => void resume()}
                  >
                    {busy === "resume" ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <PlayIcon />
                    )}{" "}
                    Use Hardcover position
                  </button>
                  <button
                    className="button ghost"
                    disabled={!!busy}
                    onClick={() => void loadEditions()}
                  >
                    {busy === "editions" ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <Headphones size={14} />
                    )}{" "}
                    Recording edition
                  </button>
                </>
              )}
              {isAdmin() && (
                <button
                  className="button ghost"
                  onClick={() => {
                    setMatching(true);
                    setMatches([]);
                  }}
                >
                  Change match <Link2 size={13} />
                </button>
              )}
              {book.hardcover.slug && (
                <a
                  className="button ghost"
                  href={`https://hardcover.app/books/${encodeURIComponent(book.hardcover.slug)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View book <ExternalLink size={13} />
                </a>
              )}
            </div>
            {book.tracks.length > 0 && (
              <p className="hardcover-help">
                Positions use this recording’s timeline. When editions differ,
                progress maps by percentage, including page-based Hardcover
                reads.
              </p>
            )}
            {options && (
              <label className="hardcover-edition-select">
                Hardcover audio edition
                <select
                  aria-label="Hardcover audio edition"
                  value={options.selectedEditionId || ""}
                  disabled={!!busy}
                  onChange={(e) =>
                    void chooseEdition(
                      e.target.value ? Number(e.target.value) : null,
                    )
                  }
                >
                  <option value="">
                    Automatic · use the current read or matching narration
                  </option>
                  {options.editions.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.narrators.join(", ") || "Audio edition"} ·{" "}
                      {duration(e.duration)} · #{e.id}
                    </option>
                  ))}
                </select>
                <small>
                  {options.durationsKnown
                    ? `Your recording: ${duration(options.localDuration)}.`
                    : "Save or play the audio to read its duration before syncing."}{" "}
                  {options.editions.length
                    ? "Choose a narration to control how positions map."
                    : "Hardcover has no audio edition; progress uses page percentage when a page count is available."}
                </small>
              </label>
            )}
            {book.hardcover.syncError && (
              <p className="inline-error" role="alert">
                {book.hardcover.syncError}
              </p>
            )}
          </>
        )}
      </section>
      <Dialog
        open={matching}
        onOpenChange={setMatching}
        title="Find this book on Hardcover"
        description="Match the work while keeping your recording and listening position."
      >
        <form
          className="hardcover-match-search"
          onSubmit={(e) => void search(e)}
        >
          <input
            aria-label="Match book title and author"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            minLength={2}
          />
          <button className="button primary" disabled={!!busy}>
            {busy === "search" ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Search size={15} />
            )}{" "}
            Search
          </button>
        </form>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="hardcover-matches">
          {matches.map((match) => (
            <article key={match.id}>
              <img src={match.image?.url || "/covers/meditations.svg"} alt="" />
              <div>
                <strong>{match.title}</strong>
                <span>
                  {match.author_names?.join(", ") || "Unknown author"}
                </span>
              </div>
              <button
                className="button subtle"
                disabled={!!busy}
                onClick={() => void link(match.id)}
              >
                {busy === String(match.id) ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <Link2 size={14} />
                )}{" "}
                Link book
              </button>
            </article>
          ))}
        </div>
      </Dialog>
    </>
  );
}
function PlayIcon() {
  return <ArrowRight size={14} />;
}
