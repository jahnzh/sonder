import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";

test("r10#4: the Docker build context leaves out secrets and local-only folders", () => {
  const rules = readFileSync(".dockerignore", "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const rule of [".env", ".env.*", "!.env.example", ".codex-attachments", "data", "artifacts", "test-results"])
    assert.ok(rules.includes(rule), rule);
  // The exception must come after the pattern it overrides.
  assert.ok(rules.indexOf("!.env.example") > rules.indexOf(".env.*"));
});

test("r10#5: the image healthcheck probes the configured PORT", async () => {
  const command = /^HEALTHCHECK .* CMD node -e "(.*)"$/m.exec(
    readFileSync("Dockerfile", "utf8"),
  )?.[1];
  assert.ok(command);
  const probe = (port: number) =>
    new Promise<boolean>((resolve) =>
      execFile(
        process.execPath,
        ["-e", command],
        { env: { ...process.env, PORT: String(port) } },
        (error) => resolve(!error),
      ),
    );
  const server = createServer((req, res) =>
    res.writeHead(req.url === "/api/health" ? 200 : 404).end(),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    assert.equal(await probe(port), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await probe(port), false);
});

test("r10#3: .env.example describes the admin and users sign-in", () => {
  const example = readFileSync(".env.example", "utf8");
  assert.doesNotMatch(example, /single-user/i);
  assert.match(example, /admin/);
});

test("r10#6: handoff notes are marked historical and point at sonder.pecori.no", () => {
  for (const name of readdirSync("docs/handoff").filter((file) => file.endsWith(".md"))) {
    const text = readFileSync(`docs/handoff/${name}`, "utf8");
    assert.match(text.slice(0, 400), /Historical note/, name);
    assert.match(text, /sonder\.pecori\.no/, name);
    assert.doesNotMatch(text, /^- Still open: the Caddy deploy/m, name);
  }
});
