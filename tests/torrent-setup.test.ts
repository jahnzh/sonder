import { test } from "node:test";
import assert from "node:assert/strict";
import {
  torrentContainerAction,
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
    torrentContainerAction(container(`container:${"a".repeat(64)}`), vpn, "vol"),
    "recreate",
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
  assert.equal(
    torrentContainerAction(container(`container:${vpn.Id}`, "old"), vpn, "vol"),
    "recreate",
  );
});

test("#123: a VPN restarted after sonder-torrents started leaves it stale, and setup restarts it", () => {
  // The case from the issue: the VPN restarted on 2026-10-30 (same container ID), sonder-torrents ran since 2026-10-27.
  const stale = container(`container:${vpn.Id}`, "vol", {
    Running: true,
    StartedAt: "2026-10-27T11:47:02.512310004Z",
  });
  const restartedVpn = { ...vpn, State: { ...vpn.State, StartedAt: "2026-10-30T00:38:57.012345678Z" } };
  assert.equal(vpnStartedSinceTorrents(stale, restartedVpn), true);
  assert.equal(torrentContainerIsCurrent(stale, restartedVpn, "vol"), false);
  assert.equal(torrentContainerAction(stale, restartedVpn, "vol"), "restart");
  // At boot Docker starts the VPN first and sonder-torrents 1.7 s later: that one is current.
  assert.equal(torrentContainerAction(container(`container:${vpn.Id}`), vpn, "vol"), "keep");
});

test("#123: a stopped container is started, because a start joins the VPN's current network", () => {
  const stopped = container(`container:${vpn.Id}`, "vol", {
    Running: false,
    StartedAt: "2026-10-27T11:47:02.512310004Z",
  });
  assert.equal(torrentContainerAction(stopped, vpn, "vol"), "start");
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
  assert.equal(torrentContainerAction(unknown, vpn, "vol"), "keep");
});
