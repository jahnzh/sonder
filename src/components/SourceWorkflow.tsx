import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import {
  BookOpen,
  Download,
  Cloud,
  ExternalLink,
  HardDrive,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Check,
  Upload,
} from "lucide-react";
import { api, localDB } from "../lib";
import {
  TorrentHealthLine,
  useTorrentHealth,
} from "./TorrentHealth";
import type {
  EbookResult,
  SavedEbook,
  Settings,
} from "../types";
type Notify = (message: string, error?: boolean) => void;
export function SourceSettings({
  settings,
  onSaved,
  notify,
}: {
  settings: Settings | null;
  onSaved: () => void;
  notify: Notify;
}) {
  const [libgenUrl, setLibgenUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (settings) {
      setLibgenUrl(settings.libgenUrl);
    }
  }, [settings]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ libgenUrl }),
      });
      onSaved();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const torrentHealth = useTorrentHealth();
  const testLocal = async () => {
    setTesting(true);
    try {
      await api("/local/test", { method: "POST" });
      const health = await torrentHealth.check(true);
      if (health && health.status !== "ok") notify(health.message, true);
      else
        notify(
          "Your local torrent client is connected. Audio stays on the 4 TB drive.",
        );
    } catch (e) {
      void torrentHealth.check(true);
      notify((e as Error).message, true);
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <section className="settings-section">
        <div className="settings-section-heading">
          <span className="settings-section-icon green">
            <HardDrive size={20} />
          </span>
          <div>
            <h2>Your home server</h2>
            <p>Uncached audiobooks download to the 4 TB media drive.</p>
          </div>
          <span
            className={`connection-tag ${settings?.localConfigured ? "connected" : ""}`}
          >
            <span />
            {settings?.localConfigured ? "Configured" : "Not configured"}
          </span>
        </div>
        <div className="source-explainer">
          <ShieldCheck size={18} />
          <span>
            TorBox is used for cached books. Everything else downloads through
            your local torrent client. Both incomplete and finished audio stay
            on the HDD. Server downloads continue when you close Sonder.
          </span>
        </div>
        <TorrentHealthLine
          health={torrentHealth.health}
          checking={torrentHealth.checking}
        />
        <button
          className="button subtle"
          onClick={() => void testLocal()}
          disabled={testing || !settings?.localConfigured}
        >
          {testing ? (
            <Loader2 className="spin" size={15} />
          ) : (
            <RefreshCw size={15} />
          )}{" "}
          Test local connection
        </button>
      </section>
      <form
        onSubmit={(e) => void save(e)}
        className="settings-form ebook-settings-form"
      >
        <section className="settings-section">
          <div className="settings-section-heading">
            <span className="settings-section-icon">
              <BookOpen size={20} />
            </span>
            <div>
              <h2>Library Genesis</h2>
              <p>Find and save EPUB and PDF editions. No key required.</p>
            </div>
          </div>
          <label>
            Mirror URL
            <input
              type="url"
              value={libgenUrl}
              onChange={(e) => setLibgenUrl(e.target.value)}
              required
              placeholder="https://libgen.li"
            />
            <small>
              Some mirrors require browser verification. The discovery view also
              links to the source website.
            </small>
          </label>
        </section>
        <div className="settings-save">
          <span>
            <HardDrive size={15} /> Ebooks are stored on the 4 TB media drive.
          </span>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Check size={15} />
            )}{" "}
            Save ebook sources
          </button>
        </div>
      </form>
    </>
  );
}
