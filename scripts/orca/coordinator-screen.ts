/**
 * Pure parsing helpers for coordinator terminal screen dumps (send-agent / check-workers).
 * Mirrors the grep/awk logic in those scripts so tests do not need live Orca terminals.
 */

/** Cursor busy line: braille spinner + Titlecase + "ing" (same pattern as send-agent.sh busy()). */
export const CURSOR_BUSY_LINE_RE =
  /^\s*[\u2800-\u28FF]+\s+[A-Z][a-z]+ing(\s|$)/u;

/**
 * check-workers.sh also treats Codex "Working (N" / "• Working (" lines as busy.
 * Mirrors: grep -qP '...|Working \(\\d|^• Working \('
 */
export const CODEX_WORKING_LINE_RE = /Working \(\d|^• Working \(/;

/**
 * Antigravity (Gemini) busy lines:
 * Primary: footer 'esc to cancel' in the last 3 lines while a turn runs.
 * Secondary: braille spinner glyph line in the last 6 lines.
 */
export const ANTIGRAVITY_CANCEL_FOOTER_RE = /esc to cancel/;
export const BRAILLE_SPINNER_RE = /[\u2800-\u28FF]/u;

/** Cursor or Codex busy line (checked anywhere across the screen). */
export function isWorkerScreenBusyLine(line: string): boolean {
  const s = String(line);
  return (
    CURSOR_BUSY_LINE_RE.test(s) ||
    CODEX_WORKING_LINE_RE.test(s)
  );
}

/** Check if an entire screen dump has any line matching busy patterns. */
export function isWorkerScreenBusy(screen: string): boolean {
  const lines = String(screen).split(/\r?\n/);
  if (lines.some((line) => isWorkerScreenBusyLine(line))) {
    return true;
  }
  const last3 = lines.slice(-3);
  if (last3.some((line) => ANTIGRAVITY_CANCEL_FOOTER_RE.test(line))) {
    return true;
  }
  const last6 = lines.slice(-6);
  if (last6.some((line) => BRAILLE_SPINNER_RE.test(line))) {
    return true;
  }
  return false;
}

/**
 * Last "┌─ follow-ups" box on screen through its closing "└" line (send-agent queue_text()).
 */
export function extractFollowUpsBox(screen: string): string {
  const lines = String(screen).split(/\r?\n/);
  let buf = "";
  let on = false;
  let last = "";
  for (const line of lines) {
    if (line.includes("┌─ follow-ups")) {
      buf = "";
      on = true;
    }
    if (on) {
      buf += `${line}\n`;
      if (/└/.test(line)) {
        on = false;
        last = buf;
      }
    }
  }
  return last;
}

/**
 * Queued item lines: │ then ○ or › then visible text (send-agent queue_count()).
 * Blanked items (no text after the marker) are not counted.
 */
export function countVisibleQueuedFollowUps(queueText: string): number {
  const re = /^[ \t]*│[ \t]*[○›][ \t]*[^\s|]/gm;
  const m = String(queueText).match(re);
  return m ? m.length : 0;
}
