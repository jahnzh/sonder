import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CTC_ENGINE,
  resetAlignmentPoolCoordinator,
  setAlignmentPoolDepsForTests,
  type PoolHost,
} from "../server/alignment-pool.ts";

export { CTC_ENGINE };

/** Pool hosts for unit tests that need CTC dispatch. Default is WSL + lisa. */
export function installCtcTestPool(
  temp: string,
  workerUrl = "http://ctc-worker.test",
  options: { lisa?: boolean } = {},
): { hosts: PoolHost[]; workerUrl: string; engine: typeof CTC_ENGINE } {
  process.env.ALIGNMENT_POOL_ENABLED = "1";
  if (!process.env.ALIGNMENT_WORKER_URL) process.env.ALIGNMENT_WORKER_URL = "http://production-worker.test";
  if (!process.env.ALIGNMENT_WORKER_TOKEN) process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
  const hosts: PoolHost[] = [
    { id: "wsl", sshTarget: "wsl", maxConcurrent: 3, remoteWorkRoot: temp, workerUrl },
  ];
  if (options.lisa !== false)
    hosts.push({
      id: "lisa",
      sshTarget: "lisa",
      maxConcurrent: 1,
      remoteWorkRoot: temp,
      workerUrl: "http://lisa-worker.test",
    });
  resetAlignmentPoolCoordinator(hosts);
  setAlignmentPoolDepsForTests({
    async probe() {
      return true;
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    async uploadFile(local, remote) {
      mkdirSync(dirname(remote), { recursive: true });
      copyFileSync(local, remote);
    },
  });
  return { hosts, workerUrl, engine: CTC_ENGINE };
}

export function ctcHealthResponse(temp: string, url: string) {
  const lisa = url.includes("lisa");
  return Response.json({
    ready: true,
    busy: false,
    stuck: false,
    mediaRoot: join(temp, lisa ? "lisa" : "wsl"),
    ctc: {
      engine: CTC_ENGINE,
      ready: true,
      device: lisa ? "cpu" : "cuda",
      precision: lisa ? "float32" : "float16",
      anchorReady: true,
      passageReady: true,
    },
  });
}

/** Wrap a test fetch so pool /health probes succeed and other URLs use `handler`. */
export function withCtcPoolFetch(
  temp: string,
  handler: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    if (String(input).endsWith("/health")) return ctcHealthResponse(temp, String(input));
    return handler(input, init);
  };
}

export function uninstallCtcTestPool() {
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
}
