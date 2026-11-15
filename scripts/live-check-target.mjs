// Which server a live verification script talks to (#431). The scripts default to production, where they sign in as
// the owner; a run there must be asked for with SONDER_VERIFY_PRODUCTION=1 (deploy.sh sets it), so a local test that
// forgot SONDER_VERIFY_URL stops before its first request instead of reaching the live site.
export const PRODUCTION_URL = "https://sonder.pecori.no";
// The public site and the production container's loopback port (compose.yaml: host networking, port 3001).
export const PRODUCTION_ORIGINS = [PRODUCTION_URL, "http://127.0.0.1:3001", "http://localhost:3001", "http://[::1]:3001"];

export function isProductionURL(url) {
  return PRODUCTION_ORIGINS.includes(new URL(url).origin);
}

// Call after loading .env and before launching a browser or sending a request.
export function verifyBaseURL(env = process.env) {
  const baseURL = env.SONDER_VERIFY_URL || PRODUCTION_URL;
  if (isProductionURL(baseURL) && env.SONDER_VERIFY_PRODUCTION !== "1")
    throw new Error(`Refusing to verify against production (${new URL(baseURL).origin}) without SONDER_VERIFY_PRODUCTION=1. Set SONDER_VERIFY_URL to test another server.`);
  return baseURL;
}
