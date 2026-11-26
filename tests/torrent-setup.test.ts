import { test } from "node:test";
import assert from "node:assert/strict";
import {
  torrentContainerAction,
  torrentContainerHasOwnVpn,
  torrentContainerIsCurrent,
  vpnStartedSinceTorrents,
  startedAtNanos,
  // @ts-expect-error The setup helper is plain JavaScript without type declarations.
} from "../scripts/torrent-container.mjs";

// Shapes and start times copied from `docker inspect` on the production host (2026-11-15), trimmed to the fields used.
const vpnStartedAt = "2026-11-14T20:38:34.175688296Z";
const vpn = {
  Id: "b".repeat(64),
  Name: "/transmission-openvpn",
  State: { Status: "running", Running: true, StartedAt: vpnStartedAt },
};
const container = (
  networkMode: string,
  volume = "vol",
  state: { Running: boolean; StartedAt: string } = {
    Running: true,
    StartedAt: "2026-11-14T20:38:35.874059592Z",
  },
) => ({
  Config: { Env: [`SONDER_MEDIA_VOLUME_ID=${volume}`] },
  HostConfig: { NetworkMode: networkMode },
  State: { Status: state.Running ? "running" : "exited", ...state },
});

const own = (volume = "vol", running = true) => ({
  ...container("bridge", volume, { Running: running, StartedAt: "2026-11-26T10:00:00.000000000Z" }),
  Config: { Env: [`SONDER_MEDIA_VOLUME_ID=${volume}`], Labels: { "sonder.vpn": "own" } },
});

test("#911: setup keeps a container with its own VPN, starts it when stopped, recreates it for another drive", () => {
  assert.equal(torrentContainerHasOwnVpn(own()), true);
  assert.equal(torrentContainerAction(own(), vpn, "vol"), "keep");
  assert.equal(torrentContainerIsCurrent(own(), vpn, "vol"), true);
  assert.equal(torrentContainerAction(own("vol", false), vpn, "vol"), "start");
  assert.equal(torrentContainerAction(own("old"), vpn, "vol"), "recreate");
});

test("#911: a container still in the shared VPN's network is recreated with its own VPN, whatever its state", () => {
  assert.equal(torrentContainerHasOwnVpn(container(`container:${vpn.Id}`)), false);
  assert.equal(torrentContainerAction(container(`container:${vpn.Id}`), vpn, "vol"), "recreate");
  assert.equal(torrentContainerAction(container("container:transmission-openvpn"), vpn, "vol"), "recreate");
  assert.equal(torrentContainerAction(container(`container:${"a".repeat(64)}`), vpn, "vol"), "recreate");
  assert.equal(torrentContainerAction(container("host"), vpn, "vol"), "recreate");
});

test("#123: the watcher's rule for a container in the shared namespace: stale once the VPN started after it", () => {
  // The case from the issue: the VPN restarted on 2026-10-30 (same container ID), sonder-torrents ran since 2026-10-27.
  const stale = container(`container:${vpn.Id}`, "vol", {
    Running: true,
    StartedAt: "2026-10-27T11:47:02.512310004Z",
  });
  const restartedVpn = { ...vpn, State: { ...vpn.State, StartedAt: "2026-10-30T00:38:57.012345678Z" } };
  assert.equal(vpnStartedSinceTorrents(stale, restartedVpn), true);
  // At boot Docker starts the VPN first and sonder-torrents 1.7 s later: that one is current.
  assert.equal(vpnStartedSinceTorrents(container(`container:${vpn.Id}`), vpn), false);
});

test("#123: start times compare to the nanosecond, and unknown times never trigger a restart", () => {
  assert.equal(
    startedAtNanos("2026-11-14T20:38:34.175688296Z") -
      startedAtNanos("2026-11-14T20:38:34.175688295Z"),
    1n,
  );
  assert.equal(startedAtNanos("2026-11-14T20:38:34Z"), startedAtNanos("2026-11-14T20:38:34.000000000Z"));
  assert.equal(startedAtNanos("2026-11-14T21:38:34+01:00"), startedAtNanos("2026-11-14T20:38:34Z"));
  assert.equal(startedAtNanos("not a time"), null);
  assert.equal(startedAtNanos(undefined), null);
  // Within the same millisecond, which Date.parse alone could not tell apart.
  const sameMs = container(`container:${vpn.Id}`, "vol", {
    Running: true,
    StartedAt: "2026-11-14T20:38:34.175688000Z",
  });
  assert.equal(vpnStartedSinceTorrents(sameMs, vpn), true);
  const unknown = container(`container:${vpn.Id}`, "vol", { Running: true, StartedAt: "" });
  assert.equal(vpnStartedSinceTorrents(unknown, vpn), false);
});
