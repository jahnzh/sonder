#!/usr/bin/env node
// Wrapper around `npx playwright test` that removes the Chromium profile directories Playwright
// leaves in the caller's working directory. Chromium creates a `playwright_chromiumdev_profile-*`
// directory in the browser process's cwd, which it inherits from the test runner's cwd. Under
// `npm run check` the browser stage already runs in a disposable directory (so the profiles die
// with it, and this cleanup is simply idempotent); for a direct `npm run test:browser` the cwd is
// the repository root, and the profiles would otherwise accumulate there (issue #89).
//
// The wrapper also creates exactly one `sonder-browser-*` directory for this run, passes its path
// to the Playwright webServer (`tests/browser-server.ts`) via SONDER_BROWSER_TEMP, and removes
// only that directory when the run ends — never other checks' live temps on a shared host (#236).
//
// The list/diff/cleanup logic is exported as pure functions so tests can exercise it against a
// temp directory with a fake child (no real browser launch).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE_PREFIX = "playwright_chromiumdev_profile-";
export const BROWSER_SERVER_PREFIX = "sonder-browser-";
/** Env var naming the one browser-server temp dir this wrapper owns for the run. */
export const BROWSER_TEMP_ENV = "SONDER_BROWSER_TEMP";

// Named temp directories directly under `dir`, sorted and deduplicated.
export function listNamedTempDirs(dir, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return [...new Set(entries)]
    .filter((name) => name.startsWith(prefix))
    .filter((name) => {
      try {
        return fs.statSync(path.join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

// The playwright_chromiumdev_profile-* directories directly under `dir`, sorted and deduplicated.
export function listProfileDirs(dir) {
  return listNamedTempDirs(dir, PROFILE_PREFIX);
}

export function listBrowserServerTemps(tmpRoot = os.tmpdir()) {
  return listNamedTempDirs(tmpRoot, BROWSER_SERVER_PREFIX);
}

// The profile directories in `after` that were not already present in `before`.
export function diffProfileDirs(before, after) {
  const seen = new Set(before);
  return after.filter((name) => !seen.has(name));
}

// Remove the named directories under `dir`. Idempotent and best effort: a profile directory that
// cannot be removed is not worth failing the run over.
export function removeProfileDirs(dir, names) {
  for (const name of names) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function removeOwnedBrowserTemp(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// Run `npx playwright test` in `cwd` with the given arguments, and on every exit path remove only
// the profile directories that appeared during the run and this run's owned browser temp.
// `spawnCommand` is injectable so tests can substitute a fake child. Resolves with the child's
// numeric exit code, or null when the child was terminated by a signal.
export function runTestBrowser({
  cwd = process.cwd(),
  args = [],
  spawnCommand = (cmd, argv, opts) => spawn(cmd, argv, opts),
  tmpRoot = os.tmpdir(),
  createBrowserTemp = () => fs.mkdtempSync(path.join(tmpRoot, BROWSER_SERVER_PREFIX)),
} = {}) {
  const beforeProfiles = listProfileDirs(cwd);
  const browserTemp = createBrowserTemp();
  const child = spawnCommand("npx", ["playwright", "test", ...args], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, [BROWSER_TEMP_ENV]: browserTemp },
  });
  return new Promise((resolve) => {
    const settle = (result) => {
      removeProfileDirs(cwd, diffProfileDirs(beforeProfiles, listProfileDirs(cwd)));
      removeOwnedBrowserTemp(browserTemp);
      resolve(result);
    };
    child.on("close", (code, signal) => settle(signal ? null : code));
    child.on("error", () => settle(1));
  });
}

const isDirectCli =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  // When the user interrupts, the signal reaches the whole process group (including the child),
  // so the child terminates on its own. We defer our own exit until the child has settled and the
  // profile directories are cleaned up, then exit with the conventional status for the signal.
  const EXIT_BY_SIGNAL = { SIGINT: 130, SIGTERM: 143 };
  let interruptedBy = null;
  const recordSignal = (sig) => () => {
    interruptedBy = sig;
  };
  process.on("SIGINT", recordSignal("SIGINT"));
  process.on("SIGTERM", recordSignal("SIGTERM"));

  runTestBrowser({ args: process.argv.slice(2) })
    .then((code) => {
      const finalCode = interruptedBy ? (EXIT_BY_SIGNAL[interruptedBy] ?? 1) : code ?? 1;
      process.exit(finalCode);
    })
    .catch((err) => {
      console.error(`[test-browser] Unexpected error: ${err.stack || err.message}`);
      process.exit(1);
    });
}
