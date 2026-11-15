import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Use the one directory `scripts/test-browser.mjs` created for this run (SONDER_BROWSER_TEMP), so
// the wrapper can remove exactly that path (#236). Only the first server may adopt it: specs such as
// account-requests, join and users spawn extra servers with `{ ...process.env }`, which inherit the
// variable. Adopting means atomically creating `<dir>/.claimed`; a server that loses that race, or runs
// without the wrapper (reuseExistingServer, ad-hoc runs), makes its own mkdtemp dir as before.
const owned = process.env.SONDER_BROWSER_TEMP;
function claim(dir: string | undefined) {
  if (!dir || !existsSync(dir)) return false;
  try {
    mkdirSync(join(dir, ".claimed"));
    return true;
  } catch {
    return false;
  }
}
const adopted = claim(owned);
const temp = adopted ? owned! : mkdtempSync(join(tmpdir(), "sonder-browser-"));
// SONDER_KEEP_BROWSER_TEMP=1 keeps this server's directory after it exits, for debugging a run.
const keepTemp = process.env.SONDER_KEEP_BROWSER_TEMP === "1";
// The marker names the process using this directory, so scripts/clean-temp.sh can leave it alone
// while this server runs and remove it once the server is gone.
writeFileSync(join(temp, ".sonder-pid"), `${process.pid}\n`);
// Remove only a directory this server created; the wrapper removes the one it owns. Removing an
// adopted directory from a secondary server deleted the main server's media mid-suite (#236).
let removed = false;
const removeTemp = () => {
  if (removed) return;
  removed = true;
  if (adopted) {
    rmSync(join(temp, ".sonder-pid"), { force: true });
  } else if (keepTemp) {
    rmSync(join(temp, ".sonder-pid"), { force: true });
    console.error(`[browser-server] kept ${temp} (SONDER_KEEP_BROWSER_TEMP=1)`);
  } else {
    rmSync(temp, { recursive: true, force: true });
  }
};
// Playwright stops this server by signalling its process group (config.webServer.gracefulShutdown);
// without that option it sends SIGKILL, which no handler sees, and every run leaked its directory.
// The handlers are in place before startup, so a server that fails to start or is stopped while it
// starts removes its directory too. A close that hangs (an open connection, a ticker) must not keep
// the process, or its directory, alive.
let app: Awaited<ReturnType<typeof import("../server/app.ts").createApp>> | undefined;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 5000).unref();
  try {
    await app?.close();
  } finally {
    removeTemp();
    process.exit(0);
  }
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
// An uncaught exception or any exit path other than stop() must not leak the temp dir. This
// synchronous handler covers every normal exit and is idempotent with stop()'s removal.
// SIGKILL cannot be caught, so a kill -9 of this process still leaks the directory.
process.on("exit", () => {
  removeTemp();
});
// A spec that must seed the database directly (for example an expired invite)
// passes its own directory; the server's temp dir keeps the media root either way.
process.env.DATA_DIR = process.env.PLAYWRIGHT_DATA_DIR || join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
// The whole suite runs from one address against one server within minutes.
process.env.API_RATE_LIMIT = "6000";
// The whole browser suite runs under the enforced app policy (#76). CSP_MODE can still be set to report-only or off
// to compare behaviour.
process.env.CSP_MODE ??= "enforce";
if (process.env.PLAYWRIGHT_AUTH !== "1") delete process.env.APP_PASSWORD;
delete process.env.TRANSMISSION_RPC_URL;
const { installHardcoverFixture } = await import(
  "./hardcover-browser-fixture.ts"
);
installHardcoverFixture();
const { installAlignmentFixture } = await import("./alignment-browser-fixture.ts");
await installAlignmentFixture();
const { installProwlarrFixture } = await import("./prowlarr-browser-fixture.ts");
installProwlarrFixture();
const { installSeriesAcquisitionFixture } = await import(
  "./series-acquisition-fixture.ts"
);
installSeriesAcquisitionFixture();
const { installSeriesReleaseBrowserFixture } = await import(
  "./series-release-browser-fixture.ts"
);
installSeriesReleaseBrowserFixture();
const { createApp } = await import("../server/app.ts");
app = await createApp();
await app.listen({ port: Number(process.env.PLAYWRIGHT_PORT || 4173), host: "127.0.0.1" });
