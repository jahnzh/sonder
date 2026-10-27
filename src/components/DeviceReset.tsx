import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { localDB } from "../lib";
import { usePlayer } from "../player";

export function DeviceReset({ notify }: { notify: (message: string, error?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const player = usePlayer();
  const reset = async () => {
    setBusy(true);
    try {
      // A unique URL avoids the service worker's cache and confirms that a
      // fresh app can be loaded before removing the offline shell.
      const response = await fetch(`/build.json?device-reset=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      const build = response.ok ? await response.json() : null;
      if (!build || typeof build.id !== "string") throw new Error("Connect to Sonder before resetting the app.");
      player.pause();
      window.dispatchEvent(new Event("pagehide"));
      // Wait for queued local progress writes; the reset leaves IndexedDB and
      // device files intact, including any progress still waiting to sync.
      await localDB.progress.toArray().catch(() => {});
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.filter(registration =>
          registration.scope === `${location.origin}/` &&
          [registration.active, registration.waiting, registration.installing].some(worker => worker && new URL(worker.scriptURL).pathname === "/sw.js"),
        ).map(registration => registration.unregister()));
      }
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith("sonder-shell-") || name.startsWith("sonder-stream-")).map(name => caches.delete(name)));
      }
      location.reload();
    } catch {
      notify("Could not reset the app. Check your connection and try again.", true);
      setBusy(false);
    }
  };
  return <section className="settings-section device-reset" aria-label="Device app reset">
    <div className="settings-section-heading">
      <span className="settings-section-icon"><RefreshCw size={20} /></span>
      <div><h2>This device</h2><p>Refresh the installed app if it is out of date or behaving unexpectedly.</p></div>
    </div>
    <p className="muted">Resetting reloads the app files and clears the streaming cache. Downloads, device settings and saved or unsynced progress stay on this device. An internet connection is required.</p>
    <button className="button subtle" disabled={busy} onClick={() => void reset()}>
      <RefreshCw size={16} /> {busy ? "Resetting app…" : "Reset app on this device"}
    </button>
  </section>;
}
