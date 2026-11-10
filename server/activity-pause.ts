/**
 * Pause switches for the background loops (#357, decisions 3 and 4). Pause means "start no new work, let the
 * running work finish". The switch lives in the settings table so it survives a restart; an environment flag
 * that disables a loop wins and cannot be toggled here. Imports only the database, so every loop can use it.
 */
import { sqlite } from "./db.ts";
import { PAUSABLE_PROCESSES, lockedByEnvironment, type PausableProcess } from "./activity-pause-model.ts";

export { PAUSABLE_PROCESSES, PAUSE_EFFECT, isPausable, lockedByEnvironment, type PausableProcess } from "./activity-pause-model.ts";

const key = (id: PausableProcess) => `activityPaused:${id}`;

export function isPaused(id: PausableProcess) {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
  return row?.value === "1";
}

/** True when the loop should not start new work: switched off here or disabled by the environment. */
export const isHeld = (id: PausableProcess, env: NodeJS.ProcessEnv = process.env) => lockedByEnvironment(id, env) || isPaused(id);

export function setPaused(id: PausableProcess, paused: boolean) {
  if (paused) sqlite.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES(?, '1')").run(key(id));
  else sqlite.prepare("DELETE FROM settings WHERE key = ?").run(key(id));
}

export function pauseState(env: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(
    PAUSABLE_PROCESSES.map((id) => [id, { paused: isPaused(id), locked: lockedByEnvironment(id, env) }]),
  ) as Record<PausableProcess, { paused: boolean; locked: boolean }>;
}
