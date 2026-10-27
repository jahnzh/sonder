// Decides whether setup can keep the existing sonder-torrents container (docker inspect objects).
export function torrentContainerIsCurrent(existing, vpn, volumeId) {
  if (!existing.Config.Env.some((v) => v === `SONDER_MEDIA_VOLUME_ID=${volumeId}`))
    return false;
  // Docker stores the VPN's container ID, so a recreated VPN leaves this pointing at a dead namespace.
  const target = /^container:(.+)$/.exec(existing.HostConfig?.NetworkMode || "")?.[1];
  return target === vpn.Id || target === vpn.Name?.replace(/^\//, "");
}
