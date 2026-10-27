import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error The setup helper is plain JavaScript without type declarations.
import { torrentContainerIsCurrent } from "../scripts/torrent-container.mjs";

const vpn = { Id: "b".repeat(64), Name: "/transmission-openvpn" };
const container = (networkMode: string, volume = "vol") => ({
  Config: { Env: [`SONDER_MEDIA_VOLUME_ID=${volume}`] },
  HostConfig: { NetworkMode: networkMode },
});

test("r3: setup recreates the torrent container when the VPN container was recreated", () => {
  assert.equal(
    torrentContainerIsCurrent(container(`container:${vpn.Id}`), vpn, "vol"),
    true,
  );
  assert.equal(
    torrentContainerIsCurrent(container(`container:${"a".repeat(64)}`), vpn, "vol"),
    false,
  );
  assert.equal(
    torrentContainerIsCurrent(container("container:transmission-openvpn"), vpn, "vol"),
    true,
  );
  assert.equal(torrentContainerIsCurrent(container("host"), vpn, "vol"), false);
  assert.equal(
    torrentContainerIsCurrent(container(`container:${vpn.Id}`, "old"), vpn, "vol"),
    false,
  );
});
