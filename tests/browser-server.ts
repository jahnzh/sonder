import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
// Remove only a directory this server created; the wrapper removes the one it owns. Removing an
// adopted directory from a secondary server deleted the main server's media mid-suite (#236).
const removeTemp = () => {
  if (!adopted) rmSync(temp, { recursive: true, force: true });
};
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
const { installAlignmentFixture, holdAlignment, heldAlignmentRequests } = await import("./alignment-browser-fixture.ts");
await installAlignmentFixture();
const { installProwlarrFixture } = await import("./prowlarr-browser-fixture.ts");
installProwlarrFixture();
const { installSeriesAcquisitionFixture } = await import(
  "./series-acquisition-fixture.ts"
);
installSeriesAcquisitionFixture();
const { createApp } = await import("../server/app.ts");
const app = await createApp();
// The alignment fixture's hold (#542): a spec keeps a real job's worker requests waiting, then lets them go.
app.post("/api/__fixture/alignment-hold", async (request) => {
  const { token, hold } = request.body as { token: string; hold: boolean };
  return { released: holdAlignment(String(token), !!hold) };
});
app.get("/api/__fixture/alignment-hold", async (request) => ({ held: heldAlignmentRequests(String((request.query as { token?: string }).token)) }));
await app.listen({ port: Number(process.env.PLAYWRIGHT_PORT || 4173), host: "127.0.0.1" });
const stop = async () => {
  await app.close();
  removeTemp();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
// An uncaught exception or any exit path other than stop() must not leak the temp dir. This
// synchronous handler covers every normal exit and is idempotent with stop()'s removal.
// SIGKILL cannot be caught, so a kill -9 of this process still leaks the directory.
process.on("exit", () => {
  removeTemp();
});
