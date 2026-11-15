// An in-process fake of the alignment pool hosts: no SSH, no network. Each host has its own directory standing
// in for the worker's MEDIA_ROOT; SSH commands run locally against it and the worker's /health and /align
// answer from the host's state. Tests flip a host down, busy or restarted and read what was staged and removed.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CTC_ENGINE, type PoolSshDeps } from "../server/alignment-pool.ts";

const execFileAsync = promisify(execFile);

export type FakeHostState = {
  id: string;
  /** Stands in for the worker's MEDIA_ROOT on that host. */
  root: string;
  sshTarget: string;
  workerUrl: string;
  device: string;
  precision: string;
  /** /health does not answer. */
  down: boolean;
  /** SSH does not answer. */
  sshDown: boolean;
  /** /health reports busy. */
  busy: boolean;
  slots?: number;
  /** The next n worker requests fail as a restarting worker does (connection reset). */
  failRequests: number;
  /** Runs before the host answers its n-th worker request (1-based), to change state mid-job. */
  onRequest?: (n: number, path: string) => void;
  /** Worker requests (path) this host answered or refused, in order. */
  requests: string[];
  /** Shell commands run over the fake SSH, in order. */
  commands: string[];
  /**
   * Runs before a shell command; the command waits for the promise it returns. The caller's abort signal is
   * ignored, as a remote command keeps running after the SSH client gives up.
   */
  holdCommand?: (command: string) => Promise<void> | void;
  /** Runs after a shell command has run on the host, before its output reaches the caller. */
  afterCommand?: (command: string) => Promise<void> | void;
};

export type FakePool = {
  hosts: Record<string, FakeHostState>;
  deps: PoolSshDeps;
  fetch: typeof fetch;
  /** Every job folder staged on a host, relative names under alignment/pool-jobs. */
  stagedFolders(hostId: string): string[];
};

/** Paths in a command must stay inside the host's directory: a test never touches anything else. */
function assertInside(host: FakeHostState, command: string) {
  for (const match of command.matchAll(/'([^']*)'/g)) {
    const path = match[1];
    if (!path.startsWith("/")) continue;
    const inside = resolve(path);
    if (inside !== host.root && !inside.startsWith(`${host.root}/`))
      throw new Error(`fake pool host ${host.id}: ${path} is outside ${host.root}`);
  }
}

export function fakePoolHosts(
  temp: string,
  specs: { id: string; device: string; precision: string }[] = [
    { id: "wsl", device: "cuda", precision: "float16" },
    { id: "lisa", device: "cpu", precision: "float32" },
  ],
  answer: (host: FakeHostState, path: string, body: any) => unknown = alignAnswer,
): FakePool {
  const hosts: Record<string, FakeHostState> = {};
  for (const spec of specs) {
    const root = join(temp, `${spec.id}-media`);
    mkdirSync(root, { recursive: true });
    hosts[spec.id] = {
      ...spec, root, sshTarget: `${spec.id}-ssh`, workerUrl: `http://${spec.id}-worker.test`,
      down: false, sshDown: false, busy: false, failRequests: 0, requests: [], commands: [],
    };
  }
  const byTarget = (target: string) => {
    const host = Object.values(hosts).find((candidate) => candidate.sshTarget === target);
    if (!host) throw new Error(`fake pool: unknown SSH target ${target}`);
    return host;
  };
  const deps: PoolSshDeps = {
    async probe(target) {
      if (byTarget(target).sshDown) throw Object.assign(new Error("Command failed"), { stderr: "ssh: connect to host: Connection refused" });
      return true;
    },
    async exec(target, command) {
      const host = byTarget(target);
      if (host.sshDown) throw Object.assign(new Error("Command failed"), { stderr: "ssh: connect to host: Connection refused" });
      assertInside(host, command);
      host.commands.push(command);
      await host.holdCommand?.(command);
      const { stdout, stderr } = await execFileAsync("sh", ["-c", command], { encoding: "utf8" });
      await host.afterCommand?.(command);
      return { code: 0, stdout, stderr };
    },
    async uploadFile(local, remote, target) {
      const host = byTarget(target);
      assertInside(host, `'${remote}'`);
      mkdirSync(dirname(remote), { recursive: true });
      copyFileSync(local, remote);
    },
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const host = Object.values(hosts).find((candidate) => url.origin === new URL(candidate.workerUrl).origin);
    if (!host) throw new Error(`fake pool: unexpected request ${url}`);
    if (url.pathname === "/health") {
      if (host.down) throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
      return Response.json({
        ready: true, busy: host.busy, stuck: false, mediaRoot: host.root,
        ...(host.slots ? { slots: host.slots } : {}),
        ctc: { engine: CTC_ENGINE, ready: true, device: host.device, precision: host.precision,
          anchorReady: true, passageReady: true },
      });
    }
    host.requests.push(url.pathname);
    host.onRequest?.(host.requests.length, url.pathname);
    if (host.failRequests > 0) {
      host.failRequests--;
      throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const reply = await answer(host, url.pathname, body);
    return reply instanceof Response ? reply : Response.json(reply);
  };
  return {
    hosts,
    deps,
    fetch: fetchImpl,
    stagedFolders(hostId) {
      const dir = join(hosts[hostId].root, "alignment", "pool-jobs");
      return existsSync(dir) ? readdirSync(dir).sort() : [];
    },
  };
}

/** A worker that maps every fragment of an /align request; it checks that the staged audio is on this host. */
export function alignAnswer(host: FakeHostState, path: string, body: any) {
  if (path !== "/align") return new Response("unexpected request", { status: 500 });
  if (!String(body.audio).startsWith(`${host.root}/`) || !existsSync(body.audio))
    return new Response("audio is not staged on this host", { status: 500 });
  return {
    engine: CTC_ENGINE, outcome: "mapped", elapsedSeconds: 1,
    intervals: body.fragments.map((_: string, index: number) => ({ index, start: body.start + index, end: body.start + index + 0.8 })),
  };
}
