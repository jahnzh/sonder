import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  Link2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { api, localDB, userId } from "../lib";
import { accountAnswer } from "../account-answer";
import type { HardcoverState } from "../types";
import { savedPreferencesToFollow, type SyncPreferences } from "../hardcover-sync-draft";
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
/** The user's Hardcover state (`GET /api/hardcover`), kept current: the Library's picker (#578), Settings and the Hardcover page (#529). */
export function useHardcover() {
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
