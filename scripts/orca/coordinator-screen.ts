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

/** Combined: one line is "busy" if either pattern matches (multiline=false per line). */
export function isWorkerScreenBusyLine(line: string): boolean {
  const s = String(line);
  return CURSOR_BUSY_LINE_RE.test(s) || CODEX_WORKING_LINE_RE.test(s);
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

/**
 * Extract probe text (normalized whitespace, first words up to 40 characters)
 * to search for a message on a terminal screen or queue.
 */
export function messageProbe(message: string): string {
  return String(message).trim().replace(/\s+/g, " ").slice(0, 40);
}

export type DeliveryStatus = "delivered" | "queued" | "not found";

/**
 * Classify delivery status of a message on a worker screen dump:
 * - "queued": probe appears inside the follow-ups queue box.
 * - "delivered": probe appears elsewhere on screen (turn start, composer, etc.).
 * - "not found": probe does not appear on screen.
 */
export function classifyDeliveryStatus(
  screen: string,
  message: string,
): DeliveryStatus {
  const probe = messageProbe(message);
  if (!probe) return "not found";

  const box = extractFollowUpsBox(screen);
  const normalizedBox = box.replace(/\s+/g, " ");
  if (normalizedBox.includes(probe)) {
    return "queued";
  }

  const normalizedScreen = String(screen).replace(/\s+/g, " ");
  if (normalizedScreen.includes(probe)) {
    return "delivered";
  }

  return "not found";
}
