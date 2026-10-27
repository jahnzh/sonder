import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "sonder-browser-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
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
