// Decides what setup and the VPN watcher do with the sonder-torrents container (docker inspect objects).

// Docker stores the VPN's container ID, so a recreated VPN leaves this pointing at a dead namespace.
export function torrentContainerJoinsVpn(existing, vpn) {
  const target = /^container:(.+)$/.exec(existing.HostConfig?.NetworkMode || "")?.[1];
  return target === vpn.Id || target === vpn.Name?.replace(/^\//, "");
}

// Docker's RFC 3339 timestamps carry nanoseconds, which Date.parse does not keep; null when unparsable.
export function startedAtNanos(value) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value || "");
  if (!m) return null;
  const ms = Date.parse(m[1] + m[3]);
  if (Number.isNaN(ms)) return null;
  return BigInt(ms) * 1_000_000n + BigInt((m[2] || "").padEnd(9, "0"));
}

// A plain VPN restart keeps its container ID but gives it a new network namespace, and a container that
// joined the old one stays there, cut off. Every start of sonder-torrents (setup, docker restart, its restart
// policy, the daemon at boot) joins the VPN's namespace of that moment and resets its State.StartedAt, so the
// two start times say exactly whether it is in the current one; a label set at creation would go stale after
// a plain restart of sonder-torrents. Unknown times count as not stale, so nothing is restarted on a guess.
export function vpnStartedSinceTorrents(existing, vpn) {
  const vpnStart = startedAtNanos(vpn.State?.StartedAt);
  const torrentStart = startedAtNanos(existing.State?.StartedAt);
  return vpnStart !== null && torrentStart !== null && vpnStart > torrentStart;
}

// What setup does with an existing container: recreate it (other drive or VPN), start it (a start joins the
// current namespace), restart it (it is running in a namespace the VPN left), or keep it.
export function torrentContainerAction(existing, vpn, volumeId) {
  if (!existing.Config.Env.some((v) => v === `SONDER_MEDIA_VOLUME_ID=${volumeId}`))
    return "recreate";
  if (!torrentContainerJoinsVpn(existing, vpn)) return "recreate";
  if (!existing.State?.Running) return "start";
  return vpnStartedSinceTorrents(existing, vpn) ? "restart" : "keep";
}

export function torrentContainerIsCurrent(existing, vpn, volumeId) {
  return torrentContainerAction(existing, vpn, volumeId) === "keep";
}
