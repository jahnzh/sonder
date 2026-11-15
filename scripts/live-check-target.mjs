// Which server a live verification script talks to (#431). The scripts default to production, where they sign in as
// the owner; a run there must be asked for with SONDER_VERIFY_PRODUCTION=1 (deploy.sh sets it), so a local test that
// forgot SONDER_VERIFY_URL stops before its first request instead of reaching the live site.
export const PRODUCTION_URL = "https://sonder.pecori.no";
// The production container listens on loopback port 3001 (compose.yaml: host networking; server/index.ts HOST).
export const PRODUCTION_PORT = 3001;
// Every name or address the production site is known by, on any port. One list: add the LAN address here (for example
// "192.168.1.20") and the guard refuses it like the public name. Entries are compared after normalising (lower case,
// no trailing dot, IPv6 without brackets), the same way as the URL being checked.
export const PRODUCTION_HOSTS = ["sonder.pecori.no"];

// Host name as the guard compares it: lower case, without the trailing dot of a fully qualified name, IPv6 without
// brackets. new URL() already lowercases names and rewrites numeric IPv4 forms (2130706433, 0x7f.1) to dotted form.
export function normalHost(host) {
  return String(host).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

const PRODUCTION_HOST_SET = new Set(PRODUCTION_HOSTS.map(normalHost));

// Every way to reach this machine's loopback interface: localhost (and *.localhost, which browsers resolve to
// loopback), 127.0.0.0/8, 0.0.0.0 and ::, ::1 and IPv4-mapped loopback.
export function isLoopbackHost(host) {
  const h = normalHost(host);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "0.0.0.0") return true;
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1" || h === "0:0:0:0:0:0:0:0") return true;
  // new URL() writes ::ffff:127.0.0.1 as ::ffff:7f00:1 (and 0.0.0.0 as ::ffff:0:0).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) return (parseInt(mapped[1], 16) >> 8) === 127 || (parseInt(mapped[1], 16) === 0 && parseInt(mapped[2], 16) === 0);
  return /^::ffff:(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0)$/.test(h);
}

/**
 * What kind of server a URL names:
 * - "production": a host in PRODUCTION_HOSTS on any port, or loopback on PRODUCTION_PORT;
 * - "local-test": loopback on another port (tests/browser-server.ts, the Vite dev server);
 * - "unknown": anything else, including a URL that does not parse or is not http(s).
 */
export function classifyTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "unknown";
  const host = normalHost(parsed.hostname);
  if (!host) return "unknown";
  if (PRODUCTION_HOST_SET.has(host)) return "production";
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (isLoopbackHost(host)) return port === PRODUCTION_PORT ? "production" : "local-test";
  return "unknown";
}

export function isProductionURL(url) {
  return classifyTarget(url) === "production";
}

function shown(url) {
  try {
    return new URL(url).origin;
  } catch {
    return JSON.stringify(String(url));
  }
}

// Call after loading .env and before launching a browser or sending a request. Without SONDER_VERIFY_PRODUCTION=1 only
// the local test server's own form (loopback on a port other than 3001) is accepted.
export function verifyBaseURL(env = process.env) {
  const baseURL = env.SONDER_VERIFY_URL || PRODUCTION_URL;
  if (env.SONDER_VERIFY_PRODUCTION === "1") return baseURL;
  const kind = classifyTarget(baseURL);
  if (kind === "production")
    throw new Error(`Refusing to verify against production (${shown(baseURL)}) without SONDER_VERIFY_PRODUCTION=1. Set SONDER_VERIFY_URL to test another server.`);
  if (kind !== "local-test")
    throw new Error(`Refusing to verify against ${shown(baseURL)} without SONDER_VERIFY_PRODUCTION=1: it is not a local test server (loopback on a port other than ${PRODUCTION_PORT}) and may be production.`);
  return baseURL;
}
