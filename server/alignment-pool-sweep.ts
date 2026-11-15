// One-time sweep of audio the pool staged on its hosts before leases removed it (ADR 0013, #394). It runs on
// request, never at startup:
//
//   node --import tsx server/alignment-pool-sweep.ts --dry-run   # list what would be removed
//   node --import tsx server/alignment-pool-sweep.ts             # remove it
//
// A job's folder is removed only when the job is finished (ready, partial, error, cancelled) or no longer exists.
// A probe's folder (`ctc-probe-*`) belongs to no job; it is removed once it is older than any probe can run.
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultPoolHosts,
  poolDeps,
  shellQuote,
  stagingFolder,
  workerMediaRoot,
  type PoolHost,
} from "./alignment-pool.ts";

/** Statuses after which a job never uses its staged audio again. */
export const FINISHED_JOB_STATUSES = ["ready", "partial", "error", "cancelled"] as const;
/** A probe holds its lease for minutes (a 5 minute wait for a host, then scoring); an hour leaves a wide margin. */
export const PROBE_FOLDER_MIN_AGE_MS = 60 * 60 * 1000;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROBE_PREFIX = "ctc-probe-";

export type SweepFolder = {
  host: string;
  name: string;
  path: string;
  /** Why the folder is removed, or why it stays. */
  reason: string;
};

export type SweepHostReport = {
  host: string;
  /** The worker's media root, or null when the host could not be listed. */
  mediaRoot: string | null;
  error?: string;
  remove: SweepFolder[];
  keep: SweepFolder[];
  /** Folders whose removal failed (never in a dry run). */
  failed: SweepFolder[];
};

export type SweepOptions = {
  dryRun: boolean;
  /** The stored status of a job, or null when there is no such job. */
  jobStatus: (id: string) => string | null;
  hosts?: PoolHost[];
  now?: () => number;
  log?: (line: string) => void;
};

/** One line per folder: `name<TAB>mtime-seconds`. An absent folder lists nothing. */
function listCommand(dir: string) {
  return `if [ -d ${shellQuote(dir)} ]; then find ${shellQuote(dir)} -mindepth 1 -maxdepth 1 -printf '%f\\t%T@\\n'; fi`;
}

function decide(name: string, modifiedMs: number, options: SweepOptions): { remove: boolean; reason: string } {
  if (!SAFE_NAME.test(name)) return { remove: false, reason: "unexpected name" };
  if (name.startsWith(PROBE_PREFIX)) {
    const age = (options.now?.() ?? Date.now()) - modifiedMs;
    return Number.isFinite(modifiedMs) && age >= PROBE_FOLDER_MIN_AGE_MS
      ? { remove: true, reason: "probe, older than an hour" }
      : { remove: false, reason: "probe, may still be running" };
  }
  const status = options.jobStatus(name);
  if (status === null) return { remove: true, reason: "job gone" };
  if ((FINISHED_JOB_STATUSES as readonly string[]).includes(status)) return { remove: true, reason: `job ${status}` };
  return { remove: false, reason: `job ${status}` };
}

/** Lists, and unless `dryRun` removes, the staged folders on every pool host whose job is finished or gone. */
export async function sweepPoolStaging(options: SweepOptions): Promise<SweepHostReport[]> {
  const log = options.log ?? (() => undefined);
  const reports: SweepHostReport[] = [];
  for (const host of options.hosts ?? defaultPoolHosts()) {
    const report: SweepHostReport = { host: host.id, mediaRoot: null, remove: [], keep: [], failed: [] };
    reports.push(report);
    let mediaRoot: string;
    try {
      mediaRoot = await workerMediaRoot(host);
    } catch (error) {
      report.error = `the worker's media root is unknown: ${(error as Error).message}`;
      log(`${host.id}: skipped: ${report.error}`);
      continue;
    }
    report.mediaRoot = mediaRoot;
    const dir = stagingFolder(mediaRoot, "").replace(/\/$/, "");
    let listing: string;
    try {
      listing = (await poolDeps().exec(host.sshTarget, listCommand(dir), { signal: AbortSignal.timeout(30_000) })).stdout;
    } catch (error) {
      report.error = `listing ${dir} failed: ${(error as Error).message}`;
      log(`${host.id}: skipped: ${report.error}`);
      continue;
    }
    for (const line of listing.split("\n").filter(Boolean).sort()) {
      const [name, seconds] = line.split("\t");
      const folder = { host: host.id, name, path: stagingFolder(mediaRoot, name) };
      const { remove, reason } = decide(name, Number(seconds) * 1000, options);
      (remove ? report.remove : report.keep).push({ ...folder, reason });
    }
    for (const folder of report.keep) log(`${host.id}: keep   ${folder.path} (${folder.reason})`);
    for (const folder of report.remove) {
      if (options.dryRun) {
        log(`${host.id}: would remove ${folder.path} (${folder.reason})`);
        continue;
      }
      try {
        await poolDeps().exec(host.sshTarget, `rm -rf ${shellQuote(folder.path)}`, { signal: AbortSignal.timeout(60_000) });
        log(`${host.id}: removed ${folder.path} (${folder.reason})`);
      } catch (error) {
        report.failed.push(folder);
        log(`${host.id}: could not remove ${folder.path}: ${(error as Error).message}`);
      }
    }
  }
  return reports;
}

const USAGE = `Usage: node --import tsx server/alignment-pool-sweep.ts [--dry-run]

Removes audio the alignment pool staged on its hosts (MEDIA_ROOT/alignment/pool-jobs/<id>) whose job is finished
or no longer exists, and probe folders older than an hour. Reads the hosts from the pool configuration and the
jobs from DATA_DIR/sonder.db (read-only).

  --dry-run   list what would be removed and remove nothing
  --help      show this help`;

export function parseSweepArgs(args: string[]): { dryRun: boolean; help: boolean } {
  let dryRun = false;
  let help = false;
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
  }
  return { dryRun, help };
}

async function main() {
  let args: ReturnType<typeof parseSweepArgs>;
  try {
    args = parseSweepArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  try {
    loadEnvFile(".env");
  } catch (error) {
    // Inside the container the settings come from its environment; there is no .env.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(resolve(process.env.DATA_DIR || "data", "sonder.db"), { readonly: true, fileMustExist: true });
  const status = db.prepare("SELECT json_extract(data,'$.status') AS status FROM alignment_jobs WHERE id=?");
  try {
    const reports = await sweepPoolStaging({
      dryRun: args.dryRun,
      jobStatus: (id) => (status.get(id) as { status: string } | undefined)?.status ?? null,
      log: (line) => console.log(line),
    });
    const removed = reports.reduce((count, report) => count + report.remove.length - report.failed.length, 0);
    const failed = reports.reduce((count, report) => count + report.failed.length, 0);
    console.log(args.dryRun
      ? `dry run: ${reports.reduce((count, report) => count + report.remove.length, 0)} folder(s) would be removed`
      : `removed ${removed} folder(s)${failed ? `, ${failed} failed` : ""}`);
    if (failed || reports.some((report) => report.error)) process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
