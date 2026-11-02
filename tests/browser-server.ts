import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "sonder-browser-"));
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
const {installAlignmentFixture}=await import('./alignment-browser-fixture.ts');
installAlignmentFixture();
const { installProwlarrFixture } = await import("./prowlarr-browser-fixture.ts");
installProwlarrFixture();
const { createApp } = await import("../server/app.ts");
const app = await createApp();
await app.listen({ port: Number(process.env.PLAYWRIGHT_PORT || 4173), host: "127.0.0.1" });
const stop = async () => {
  await app.close();
  rmSync(temp, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
// An uncaught exception or any exit path other than stop() must not leak the temp dir. This
// synchronous handler covers every normal exit and is idempotent with stop()'s removal.
// SIGKILL cannot be caught, so a kill -9 of this process still leaks the directory.
process.on("exit", () => {
  rmSync(temp, { recursive: true, force: true });
});
