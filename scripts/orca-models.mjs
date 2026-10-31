#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseBaseline } from "./orca-recommend.mjs";
import { defaultStateDir, PROVIDERS } from "./orca-usage.mjs";
import { applicableWindows, resolveModelFamily } from "./antigravity-usage.mjs";
import { evaluateCursorObservation } from "./cursor-usage.mjs";
import { scrub } from "./usage-common.mjs";

const PROVIDER_TIMEOUT_MS = 30_000;
const USAGE = `Usage: node scripts/orca-models.mjs list [--json]
       node scripts/orca-models.mjs diff
       node scripts/orca-models.mjs verify <agent>/<model> [--base <branch>] [--write <dir>]`;

function run(command, args, timeout) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? { error: error.killed ? "timed out" : "command failed" } : { stdout });
    });
  });
}

function parseModels(text, separator) {
  const models = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = separator === "tab"
      ? /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\t([^\t]+)\s*$/.exec(line)
      : /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.+?)\s*$/.exec(line);
    if (!match || scrub(match[1]) !== match[1]) continue;
    models.set(match[1], { id: match[1], label: scrub(match[2]).slice(0, 160) });
  }
  return [...models.values()];
}

function documentedModels(candidates, agent) {
  return [...new Set(candidates.filter((candidate) => candidate.agent === agent).map((candidate) => candidate.model))]
    .map((id) => ({ id, label: id }));
}

async function discover(agent, candidates) {
  if (agent === "antigravity" || agent === "cursor") {
    const result = await run(agent === "antigravity" ? "agy" : "agent", agent === "antigravity" ? ["models"] : ["--list-models"], PROVIDER_TIMEOUT_MS);
    if (result.error) return { status: "unavailable", message: result.error, models: [], count: 0 };
    const models = parseModels(result.stdout, agent === "antigravity" ? "tab" : "dash");
    if (!models.length) return { status: "unavailable", message: "no models found in provider output", models, count: 0 };
    return { status: "ok", models, count: models.length };
  }
  const started = Date.now();
  const help = await run(agent, ["--help"], PROVIDER_TIMEOUT_MS);
  if (help.error) return { status: "unavailable", message: `provider help ${help.error}`, models: documentedModels(candidates, agent), count: documentedModels(candidates, agent).length };
  if (/^\s{2,}models(?:\s|\[|$)/m.test(help.stdout)) {
    const listed = await run(agent, ["models"], Math.max(1, PROVIDER_TIMEOUT_MS - (Date.now() - started)));
    if (listed.error) return { status: "unavailable", message: `provider list ${listed.error}`, models: documentedModels(candidates, agent), count: documentedModels(candidates, agent).length };
    const models = parseModels(listed.stdout, "dash");
    if (!models.length) return { status: "unavailable", message: "no models found in provider output", models: documentedModels(candidates, agent), count: documentedModels(candidates, agent).length };
    return { status: "ok", models, count: models.length };
  }
  const models = documentedModels(candidates, agent);
  return { status: "documented", message: "no provider list available", models, count: models.length };
}

async function listProviders(candidates) {
  const agents = ["antigravity", "cursor", "claude", "codex"];
  return Object.fromEntries(await Promise.all(agents.map(async (agent) => [agent, await discover(agent, candidates)])));
}

// Do not instantiate UsageStore: its constructor creates and migrates the collector database.
function collectorReadings() {
  let db;
  try {
    db = new DatabaseSync(path.join(defaultStateDir(), "usage.sqlite"), { readOnly: true });
    const latest = db.prepare("SELECT observation FROM readings WHERE provider = ? ORDER BY observed_at DESC, id DESC LIMIT 1");
    const usable = db.prepare("SELECT observation FROM readings WHERE provider = ? AND usable = 1 ORDER BY observed_at DESC, id DESC LIMIT 1");
    return Object.fromEntries(PROVIDERS.map(({ name }) => {
      try {
        const newest = latest.get(name);
        const parsed = newest ? JSON.parse(newest.observation) : null;
        if (["unknown_account", "account_mismatch"].includes(parsed?.status)) return [name, parsed];
        const good = usable.get(name);
        return [name, good ? JSON.parse(good.observation) : parsed];
      } catch {
        return [name, null];
      }
    }));
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

function candidateDetails(agent, model, reading, verified) {
  const provider = PROVIDERS.find((item) => item.name === agent);
  let assessment = { status: "unknown", buckets: [] };
  if (reading) {
    try { assessment = provider.assessCandidate(reading, { model }, new Date()); } catch { /* malformed collector reading */ }
  }
  let buckets = [];
  if (agent === "antigravity" && resolveModelFamily(model)) {
    buckets = applicableWindows(reading, { model })?.windowIds ?? [];
  } else if (agent === "cursor") {
    try {
      // The reader itself resolves Auto without a model scope; named models need the collector's scope.
      const source = reading ?? { status: "unknown", observedAt: new Date().toISOString(), windows: [{ id: "included_auto", kind: "percentage_allowance", usedPercent: 0 }] };
      const bucket = evaluateCursorObservation(source, { model }).evaluatedModel?.bucket;
      if (bucket && bucket !== "unknown" && bucket !== "overall") {
        buckets = [bucket, ...(assessment.buckets ?? []).map((window) => window.id).filter((id) => id === "included_total")];
      }
    } catch { /* unknown bucket */ }
  } else if (agent === "claude" || agent === "codex") {
    buckets = (assessment.buckets ?? []).map((bucket) => bucket.id).filter(Boolean);
    if (!buckets.length && verified) buckets = [agent === "claude" ? "Claude session/week" : "Codex allowance"];
  }
  buckets = buckets.filter((bucket) => typeof bucket === "string" && scrub(bucket) === bucket);
  return { buckets, status: assessment.status ?? "unknown" };
}

function addCursorFreeBucket(providers, readings) {
  providers.cursor.freeBucketModels = providers.cursor.models
    .filter(({ id }) => candidateDetails("cursor", id, readings.cursor, false).buckets.includes("included_auto"))
    .map(({ id }) => id);
}

function printList(providers) {
  for (const [agent, provider] of Object.entries(providers)) {
    console.log(`${agent}: ${provider.count} models${provider.message ? ` (${provider.message})` : ""}`);
    if (agent === "cursor") console.log(`  Cursor Models bucket (${provider.freeBucketModels.length}): ${provider.freeBucketModels.join(", ") || "none mapped"}`);
    for (const model of provider.models) console.log(`  ${model.id} - ${model.label}`);
  }
}

function printDiff(providers, candidates, readings) {
  for (const [agent, provider] of Object.entries(providers)) {
    console.log(`${agent}: ${provider.count} models${provider.message ? ` (${provider.message})` : ""}`);
    const verified = new Map(candidates.filter((candidate) => candidate.agent === agent).map((candidate) => [candidate.model, candidate]));
    const offered = new Set(provider.models.map((model) => model.id));
    for (const model of provider.models) {
      const entry = verified.get(model.id);
      const usage = candidateDetails(agent, model.id, readings[agent], Boolean(entry));
      const flags = [!usage.buckets.length ? "UNMAPPED" : null, !entry && ["fresh", "low"].includes(usage.status) && usage.buckets.length ? "CANDIDATE" : null].filter(Boolean);
      console.log(`  ${agent}/${model.id} ${entry ? `verified (${entry.capability})` : "UNVERIFIED"} bucket=${usage.buckets.join(",") || "unknown"} usage=${usage.status}${flags.length ? ` ${flags.join(" ")}` : ""}`);
    }
    for (const [model, entry] of verified) {
      if (!offered.has(model)) {
        const usage = candidateDetails(agent, model, readings[agent], true);
        const flag = provider.status === "ok" ? "STALE ROW" : "LIST UNAVAILABLE";
        console.log(`  ${agent}/${model} verified (${entry.capability}) bucket=${usage.buckets.join(",") || "unknown"} usage=${usage.status}${usage.buckets.length ? "" : " UNMAPPED"} ${flag}`);
      }
    }
  }
}

function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function verify(args) {
  const choice = /^([a-z]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(args[0] ?? "");
  if (!choice || !["antigravity", "cursor", "claude", "codex"].includes(choice[1])) return 2;
  let base = "main";
  let directory;
  const seen = new Set();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!["--base", "--write"].includes(flag) || seen.has(flag) || !value || value.startsWith("-") || /[\x00-\x1f\x7f]/.test(value)) return 2;
    seen.add(flag);
    if (flag === "--base") base = value;
    else directory = value;
  }
  const [, agent, model] = choice;
  const filename = `model-verification-${agent}-${model}.md`;
  const specFile = directory ? path.join(directory, filename) : filename;
  const spec = `# Read-only model verification

Requested agent/model: ${agent}/${model}

Read the first 12 lines of AGENTS.md with \`head -n 12 AGENTS.md\`.
Run \`git log -1\` and \`node -v\`.
Report your effective model id, the command results, and whether the effective model matches the requested model. Omit names, email addresses, commit hashes, and host or account identifiers.
Make no changes to files, git, or external systems; do not launch workers.
`;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(specFile, spec, { flag: "wx" });
  }
  const launch = ["scripts/orca-spawn.sh", "--spec-file", specFile, "--name", `verify-model-${agent}-${model}`, "--base", base, "--agent", agent, "--model", model].map(shellQuote).join(" ");
  console.log(`${directory ? "Spec written to" : "Save this spec to"} ${specFile} before a real launch.\n\n${launch}\n\n${spec}`);
  return 0;
}

async function main(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === "verify") {
    const status = verify(argv.slice(1));
    if (status === 2) console.error(USAGE);
    return status;
  }
  if (!((argv[0] === "list" && (argv.length === 1 || (argv.length === 2 && argv[1] === "--json"))) || (argv[0] === "diff" && argv.length === 1))) {
    console.error(USAGE);
    return 2;
  }
  const candidates = parseBaseline(readFileSync(path.join("docs", "agents", "models.md"), "utf8"));
  const providers = await listProviders(candidates);
  const readings = collectorReadings();
  addCursorFreeBucket(providers, readings);
  if (argv[0] === "diff") printDiff(providers, candidates, readings);
  else if (argv.includes("--json")) console.log(JSON.stringify({ providers }, null, 2));
  else printList(providers);
  return 0;
}

main(process.argv.slice(2)).then((status) => { process.exitCode = status; }).catch(() => {
  console.error("Could not complete model discovery or write the requested spec.");
  process.exitCode = 1;
});
