import type { FastifyInstance } from "fastify";

export type CspMode = "report-only" | "enforce" | "off";

export const CSP_REPORT_PATH = "/api/csp-report";
const REPORT_LIMIT = 20;
const REPORT_GLOBAL_LIMIT = 200;
const REPORT_CLIENTS = 1000;
const REPORT_WINDOW_MS = 60_000;
const REPORT_BODY_LIMIT = 8 * 1024;

/** `CSP_MODE` from the environment. Anything unset or unrecognised stays report-only so a typo can't break the app. */
export function cspMode(value = process.env.CSP_MODE): CspMode {
  const mode = value?.trim().toLowerCase();
  return mode === "enforce" || mode === "off" ? mode : "report-only";
}

// What the app really needs, found in the built shell and src/:
// - script-src 'self' only: the Vite build emits no inline script (the build id is compiled into the bundle).
// - style-src 'unsafe-inline': Radix injects <style> elements. blob: and data: let a reader frame, which inherits this
//   policy, load the stylesheets epub.js rewrites to blob: URLs.
// - img-src https:: Hardcover and torrent-site cover URLs are stored as https:// links and shown directly.
// - connect-src 'self': the client only calls its own origin; Hardcover, TorBox and the sources are server-side.
// - base-uri 'self': epub.js sets a same-origin <base> in the documents it parses for the reader, and the browser applies
//   this policy to them. The app's own shell has none.
// - frame-src blob:: reader frames and documents the page builds from Blobs; srcdoc frames are not subject to it.
const DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' blob: data: https:",
  "font-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "connect-src 'self'",
  "style-src 'self' 'unsafe-inline' blob: data:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self' blob:",
];

export function cspPolicy(): string {
  return [...DIRECTIVES, `report-uri ${CSP_REPORT_PATH}`].join("; ");
}

/** The header the mode calls for, or null when none is sent. */
export function cspHeader(mode: CspMode): [name: string, value: string] | null {
  if (mode === "off") return null;
  return [
    mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
    cspPolicy(),
  ];
}

const clean = (value: string, max: number) =>
  value.replace(/[^\x20-\x7e]/g, "?").slice(0, max);

/** A URL reduced to something safe to log: no query, fragment or inline data. */
function shortUri(value: unknown): string {
  if (typeof value !== "string" || !value) return "-";
  const scheme = /^(data|blob|javascript|about):/i.exec(value);
  if (scheme) return scheme[0].toLowerCase();
  try {
    const url = new URL(value);
    return clean(`${url.origin}${url.pathname}`, 120);
  } catch {
    return clean(value, 40);
  }
}

const directiveOf = (value: unknown) =>
  typeof value === "string" ? clean(value.split(/\s+/)[0] ?? "", 40) || "-" : "-";

/** One log line per violation in either report format, ignoring anything that is not one. */
export function violationLines(payload: unknown): string[] {
  const items = Array.isArray(payload) ? payload : [payload];
  const lines: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    // application/csp-report wraps the fields in "csp-report"; application/reports+json sends
    // {type: "csp-violation", body: {...}} with camelCase names.
    const legacy = record["csp-report"];
    const modern = record.type === "csp-violation" ? record.body : undefined;
    const fields = [legacy, modern].find((v) => v && typeof v === "object") as
      | Record<string, unknown>
      | undefined;
    if (!fields) continue;
    const directive =
      fields["effective-directive"] ?? fields.effectiveDirective ?? fields["violated-directive"] ?? fields.violatedDirective;
    const blocked = fields["blocked-uri"] ?? fields.blockedURL ?? fields.blockedURI;
    const source = fields["source-file"] ?? fields.sourceFile;
    lines.push(
      `csp violation: directive=${directiveOf(directive)} blocked=${shortUri(blocked)} source=${shortUri(source)}`,
    );
  }
  return lines;
}

export interface CspOptions {
  mode: CspMode;
  /** Receives each stored violation line. Defaults to a warning in the server log. */
  report?: (line: string) => void;
  now?: () => number;
}

/**
 * Adds the policy header to HTML shell responses (and the service worker script, whose own response
 * carries the policy for the worker) and the report endpoint the policy points at.
 */
export function registerCsp(app: FastifyInstance, options: CspOptions): void {
  const header = cspHeader(options.mode);
  const report = options.report ?? ((line) => app.log.warn(line));
  const now = options.now ?? Date.now;
  if (header)
    app.addHook("onSend", async (req, reply) => {
      const path = req.url.split("?")[0];
      if (path.startsWith("/api/")) return;
      const type = String(reply.getHeader("content-type") ?? "");
      if (/^text\/html\b/i.test(type) || path === "/sw.js") reply.header(header[0], header[1]);
    });
  // Each client address has its own quota, so one client cannot use up everyone's reports and blind the log;
  // a larger global ceiling still bounds the total, and the table of addresses is bounded too.
  const stored = new Map<string, number[]>();
  const everyone: number[] = [];
  const within = (times: number[], at: number) => {
    while (times.length && at - times[0] >= REPORT_WINDOW_MS) times.shift();
    return times;
  };
  // A child scope so the lenient parsers below don't touch the JSON handling of every other route.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      { parseAs: "string", bodyLimit: REPORT_BODY_LIMIT },
      (_req, body, done) => done(null, body),
    );
    scope.post(CSP_REPORT_PATH, { bodyLimit: REPORT_BODY_LIMIT }, async (req, reply) => {
      let payload: unknown;
      try {
        payload = typeof req.body === "string" ? JSON.parse(req.body) : undefined;
      } catch {
        payload = undefined;
      }
      const at = now();
      within(everyone, at);
      if (stored.size > REPORT_CLIENTS) {
        for (const [address, times] of stored) if (!within(times, at).length) stored.delete(address);
        if (stored.size > REPORT_CLIENTS) stored.clear();
      }
      const mine = within(stored.get(req.ip) ?? [], at);
      stored.set(req.ip, mine);
      for (const line of violationLines(payload)) {
        if (mine.length >= REPORT_LIMIT || everyone.length >= REPORT_GLOBAL_LIMIT) return reply.code(429).send();
        mine.push(at);
        everyone.push(at);
        report(line);
      }
      return reply.code(204).send();
    });
  });
}
