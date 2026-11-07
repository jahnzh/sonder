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

/**
 * Extract probe prefix and suffix (first 30 and last 30 characters of normalized whitespace)
 * to search for a message on a terminal screen or queue without prefix collisions.
 */
export function messageProbes(message: string): { prefix: string; suffix: string } {
  const normalized = String(message).trim().replace(/\s+/g, " ");
  if (!normalized) return { prefix: "", suffix: "" };
  const prefix = normalized.slice(0, 30);
  const suffix = normalized.length > 30 ? normalized.slice(-30) : prefix;
  return { prefix, suffix };
}

/** Check if text contains both the prefix (first 30 chars) and suffix (last 30 chars) of message. */
export function matchesMessageProbe(text: string, message: string): boolean {
  const { prefix, suffix } = messageProbes(message);
  if (!prefix) return false;
  const normalizedText = String(text).replace(/\s+/g, " ");
  return normalizedText.includes(prefix) && normalizedText.includes(suffix);
}

/** Legacy 40-character single probe (for backwards compatibility). */
export function messageProbe(message: string): string {
  return String(message).trim().replace(/\s+/g, " ").slice(0, 40);
}

export type DeliveryStatus =
  | "delivered"
  | "queued"
  | "typed_no_turn"
  | "not found";

/**
 * Classify delivery status of a message on a worker screen dump:
 * - "queued": probe appears inside the follow-ups queue box.
 * - "delivered": probe appears on screen outside queue AND worker is busy (evidence of turn start).
 * - "typed_no_turn": probe appears on screen outside queue but worker is not busy (swallowed Enter).
 * - "not found": probe does not appear on screen.
 */
export function classifyDeliveryStatus(
  screen: string,
  message: string,
): DeliveryStatus {
  const { prefix } = messageProbes(message);
  if (!prefix) return "not found";

  const box = extractFollowUpsBox(screen);
  if (matchesMessageProbe(box, message)) {
    return "queued";
  }

  if (matchesMessageProbe(screen, message)) {
    if (isWorkerScreenBusy(screen)) {
      return "delivered";
    }
    return "typed_no_turn";
  }

  return "not found";
}
