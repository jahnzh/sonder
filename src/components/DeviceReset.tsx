// Reset this device (Settings › App; board SettingsApp.dc.html): reloads the app's files and clears the streaming
// cache. Books kept on this device, places and settings stay; it asks once, and needs a connection to the server.
import { useState } from "react";
import { localDB } from "../lib";
import { usePlayer } from "../player";
import { Button } from "../parts/Button";
import { Row } from "../parts/Row";
import { InfoMark } from "../parts/Tooltip";
import { tip } from "../tooltip-texts";
import { Dialog } from "./ui/dialog";

export const RESET_FAILED = "Could not reset the app. Check your connection and try again.";

/** Resets the app on this device and reloads it; throws when the server cannot be reached, leaving everything as it was. */
export async function resetDevice(pause: () => void): Promise<void> {
  // A unique URL avoids the service worker's cache and confirms that a fresh app can be loaded before removing the
  // offline shell.
  const response = await fetch(`/build.json?device-reset=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  const build = response.ok ? await response.json() : null;
  if (!build || typeof build.id !== "string") throw new Error("Connect to Sonder before resetting the app.");
  pause();
  window.dispatchEvent(new Event("pagehide"));
  // Wait for queued local progress writes; the reset leaves IndexedDB and device files intact, including any
  // progress still waiting to sync.
  await localDB.progress.toArray().catch(() => {});
  await localDB.positionHistory.clear();
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter(
          (registration) =>
            registration.scope === `${location.origin}/` &&
            [registration.active, registration.waiting, registration.installing].some(
              (worker) => worker && new URL(worker.scriptURL).pathname === "/sw.js",
            ),
        )
        .map((registration) => registration.unregister()),
    );
  }
  if ("caches" in window) {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name.startsWith("sonder-shell-") || name.startsWith("sonder-stream-")).map((name) => caches.delete(name)),
    );
  }
  location.reload();
}

/** The row with its Reset button, and the question it asks first. */
export function DeviceResetRow({ notify }: { notify: (message: string, error?: boolean) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const player = usePlayer();
  const reset = async () => {
    setAsking(false);
    setBusy(true);
    try {
      await resetDevice(() => player.pause());
    } catch {
      notify(RESET_FAILED, true);
      setBusy(false);
    }
  };
  return (
    <>
      <Row
        label="Reset this device"
        info={<InfoMark name="Reset this device" text={tip("resetDevice")} />}
        control={
          <Button kind="secondary" disabled={busy} onClick={() => setAsking(true)}>
            {busy ? "Resetting…" : "Reset"}
          </Button>
        }
      />
      <Dialog open={asking} onOpenChange={setAsking} title="Reset this device?" className="account-dialog">
        <div className="account-dialog-actions">
          <Button kind="secondary" onClick={() => setAsking(false)}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => void reset()}>
            Reset
          </Button>
        </div>
      </Dialog>
    </>
  );
}
