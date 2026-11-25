// Fetching from the ebook sources' public addresses only (moved from server/ebooks.ts, #901): every address is checked
// when the connection is made, redirects are followed by hand and checked again, and only https on port 443 is used.
import dns, { type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";
// Separate lists, because BlockList also matches IPv4 addresses against IPv6
// rules as IPv4-mapped addresses, which ::ffff:0:0/96 would always match.
const privateV4 = new BlockList(),
  privateV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  privateV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2002::", 16], // 6to4
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  privateV6.addSubnet(network, prefix, "ipv6");
export function privateAddress(ip: string) {
  const family = isIP(ip);
  if (!family) return true;
  return family === 6
    ? privateV6.check(ip, "ipv6")
    : privateV4.check(ip, "ipv4");
}
class PrivateAddressError extends Error {
  constructor() {
    super("Downloads from private network addresses are not allowed.");
  }
}
// Every address is checked when the connection is made, so a host can't pass
// the check with one DNS answer and connect with another.
const publicAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { ...options, all: true }, (error, found) => {
        const addresses = found as unknown as LookupAddress[];
        if (error) return callback(error, "", 0);
        if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
          return callback(new PrivateAddressError(), "", 0);
        if ((options as { all?: boolean }).all)
          return (callback as unknown as (e: null, a: LookupAddress[]) => void)(
            null,
            addresses,
          );
        callback(null, addresses[0].address, addresses[0].family);
      });
    },
  },
});
// Waiting for a response and waiting between body chunks are limited separately,
// so a large file on a slow mirror isn't cut off while it is still arriving.
export const ebookTimeouts = { response: 60000, idle: 60000 };
export async function publicFetch(input: string, given: RequestInit = {}) {
  let url = new URL(input);
  let init = given;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !["", "443"].includes(url.port)
    )
      throw new Error(
        "The source did not provide a secure public download URL.",
      );
    // Literal addresses never reach the agent's lookup.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && privateAddress(host)) throw new PrivateAddressError();
    const waiting = new AbortController();
    const timer = setTimeout(
      () =>
        waiting.abort(new Error("The ebook source did not respond in time.")),
      ebookTimeouts.response,
    );
    let response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: init.signal
          ? AbortSignal.any([init.signal, waiting.signal])
          : waiting.signal,
        dispatcher: publicAgent,
      } as RequestInit);
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause;
      throw cause instanceof PrivateAddressError ? cause : error;
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      // A caller that reads the redirect itself (a sign-in's cookies are on it) gets it as it came.
      if (init.redirect === "manual") return response;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location)
        throw new Error("The ebook source returned an invalid redirect.");
      // A redirect to another site does not carry the account's cookies or credentials there (#901).
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        const headers = new Headers(init.headers);
        for (const name of ["cookie", "authorization"]) headers.delete(name);
        init = { ...init, headers };
      }
      url = new URL(location, url);
      continue;
    }
    return response;
  }
  throw new Error("The ebook source redirected too many times.");
}
