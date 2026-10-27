import { loadEnvFile } from "node:process";
try {
  loadEnvFile(".env");
} catch {}
const { createApp } = await import("./app.ts");
const app = await createApp();
await app.listen({
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || "127.0.0.1",
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
