import { useEffect, useState, type FormEvent } from "react";
import { Check, Loader2, RefreshCw, Search } from "lucide-react";
import { api } from "../lib";
import type { Settings } from "../types";

export function ProwlarrSettings({
  settings,
  onSaved,
  notify,
}: {
  settings: Settings | null;
  onSaved: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (settings) setUrl(settings.prowlarrUrl || "");
  }, [settings]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({
          prowlarrUrl: url.trim(),
          ...(key ? { prowlarr: key.trim() } : {}),
        }),
      });
      setKey("");
      onSaved();
      notify("Prowlarr settings saved.");
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      const result = await api<{ version: string; indexers: number }>(
        "/prowlarr/test",
        { method: "POST" },
      );
      notify(
        `Prowlarr ${result.version} is connected with ${result.indexers} torrent ${result.indexers === 1 ? "indexer" : "indexers"}.`,
      );
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setTesting(false);
    }
  };
  const remove = async () => {
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ prowlarr: "", prowlarrUrl: "" }),
      });
      setUrl("");
      onSaved();
      notify("Prowlarr removed.");
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  return (
    <form
      className="settings-form prowlarr-settings-form"
      onSubmit={(event) => void save(event)}
    >
      <section className="settings-section">
        <div className="settings-section-heading">
          <span className="settings-section-icon">
            <Search size={20} />
          </span>
          <div>
            <h2>Prowlarr</h2>
            <p>Searches your Prowlarr indexers alongside AudioBookBay.</p>
          </div>
          <span
            className={`connection-tag ${settings?.prowlarrConfigured ? "connected" : ""}`}
          >
            <span />
            {settings?.prowlarrConfigured ? "Connected" : "Not connected"}
          </span>
        </div>
        <label>
          Address
          <input
            type="url"
            aria-label="Prowlarr address"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://127.0.0.1:9696"
          />
        </label>
        <label>
          API key
          <input
            type="password"
            aria-label="Prowlarr API key"
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={
              settings?.prowlarrConfigured
                ? "••••••••••••••••  ·  Saved securely"
                : "Prowlarr → Settings → General → API Key"
            }
          />
          <small>Save before testing.</small>
        </label>
        <div className="settings-inline-actions">
          <button className="button primary" disabled={busy}>
            {busy ? <Loader2 className="spin" size={15} /> : <Check size={15} />}{" "}
            Save Prowlarr
          </button>
          <button
            type="button"
            className="button subtle"
            disabled={testing || !settings?.prowlarrConfigured}
            onClick={() => void test()}
          >
            {testing ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <RefreshCw size={15} />
            )}{" "}
            Test Prowlarr
          </button>
        </div>
        {(settings?.prowlarrConfigured || settings?.prowlarrUrl) && (
          <button
            className="text-danger"
            type="button"
            onClick={() => void remove()}
          >
            Remove Prowlarr
          </button>
        )}
      </section>
    </form>
  );
}
