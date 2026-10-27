// A separate Transmission queue shares the existing VPN, without changing the shared daemon.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { torrentContainerIsCurrent } from "./torrent-container.mjs";
const root = resolve(process.env.MEDIA_ROOT || "/mnt/usb_4t_1/sonder");
if (statSync("/mnt/usb_4t_1").dev === statSync("/").dev)
  throw new Error("The 4 TB media drive is not mounted.");
let mediaParent = root;
while (!existsSync(mediaParent)) mediaParent = resolve(mediaParent, "..");
if (statSync(mediaParent).dev !== statSync("/mnt/usb_4t_1").dev)
  throw new Error("MEDIA_ROOT must be on the mounted 4 TB drive.");
const vpn = JSON.parse(
  execFileSync("docker", ["inspect", "transmission-openvpn"], {
    encoding: "utf8",
  }),
)[0];
if (!vpn.State.Running)
  throw new Error("Start the existing transmission-openvpn container first.");
const network = Object.values(vpn.NetworkSettings.Networks).find(
  (n) => n.IPAddress,
);
if (!network) throw new Error("The VPN container has no reachable address.");
const config = resolve("data/transmission");
mkdirSync(config, { recursive: true, mode: 0o700 });
for (const folder of ["complete", "incomplete", "imports", "ebooks", "demo", "alignment"])
  mkdirSync(join(root, folder), { recursive: true, mode: 0o750 });
let env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const get = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1];
const password =
  get("TRANSMISSION_PASSWORD") || randomBytes(32).toString("hex");
const volumeMarker = join(root, ".media-volume");
const volumeId = existsSync(volumeMarker)
  ? readFileSync(volumeMarker, "utf8").trim()
  : randomBytes(24).toString("hex");
if (!existsSync(volumeMarker))
  writeFileSync(volumeMarker, volumeId + "\n", { mode: 0o640, flag: "wx" });
const values = {
  APP_PASSWORD: get("APP_PASSWORD") || randomBytes(18).toString("base64url"),
  MEDIA_VOLUME_ID: volumeId,
  MEDIA_ROOT: root,
  TRANSMISSION_RPC_URL: `http://${network.IPAddress}:9092/transmission/rpc`,
  TRANSMISSION_USERNAME: "sonder",
  TRANSMISSION_PASSWORD: password,
  TRANSMISSION_DOWNLOAD_DIR: "/downloads/complete",
  ALIGNMENT_WORKER_URL: get("ALIGNMENT_WORKER_URL") || "http://127.0.0.1:3012",
  ALIGNMENT_WORKER_TOKEN: get("ALIGNMENT_WORKER_TOKEN") || randomBytes(32).toString("hex"),
};
for (const [key, value] of Object.entries(values)) {
  const re = new RegExp(`^${key}=.*$`, "m");
  env = re.test(env)
    ? env.replace(re, `${key}=${value}`)
    : env + `${env.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
}
writeFileSync(".env", env, { mode: 0o600 });
chmodSync(".env", 0o600);
let existing = null;
try {
  existing = JSON.parse(
    execFileSync("docker", ["inspect", "sonder-torrents"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  )[0];
} catch {}
if (existing && !torrentContainerIsCurrent(existing, vpn, volumeId)) {
  execFileSync("docker", ["stop", "sonder-torrents"], { stdio: "ignore" });
  execFileSync("docker", ["rm", "sonder-torrents"], { stdio: "ignore" });
  existing = null;
}
if (!existing) {
  if (!existsSync(join(config, "settings.json")))
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify(
        {
          "rpc-enabled": true,
          "rpc-bind-address": "0.0.0.0",
          "rpc-port": 9092,
          "rpc-authentication-required": true,
          "rpc-username": "sonder",
          "rpc-password": password,
          "rpc-whitelist-enabled": false,
          "rpc-host-whitelist-enabled": false,
          "download-dir": "/downloads/complete",
          "incomplete-dir": "/downloads/incomplete",
          "incomplete-dir-enabled": true,
          "rename-partial-files": true,
          "peer-port": 51414,
          "peer-port-random-on-start": false,
          "port-forwarding-enabled": false,
          "lpd-enabled": false,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      "sonder-torrents",
      "--no-healthcheck",
      "--restart",
      "unless-stopped",
      "--network",
      "container:transmission-openvpn",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--mount",
      `type=bind,source=${root},target=/downloads`,
      "--mount",
      `type=bind,source=${config},target=/config`,
      "--mount",
      `type=bind,source=${resolve("scripts/torrent-entrypoint.sh")},target=/sonder-entrypoint.sh,readonly`,
      "--env",
      `SONDER_MEDIA_VOLUME_ID=${volumeId}`,
      "--entrypoint",
      "/bin/sh",
      vpn.Config.Image,
      "/sonder-entrypoint.sh",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
} else {
  const mount = existing.Mounts.find((m) => m.Destination === "/downloads");
  if (mount?.Source !== root)
    throw new Error(
      "The existing Sonder torrent container uses a different media drive. Inspect it before continuing.",
    );
  if (!existing.State.Running)
    execFileSync("docker", ["start", "sonder-torrents"], { stdio: "ignore" });
}
console.log(
  `Sonder torrent queue is configured. Media: ${root}. VPN: transmission-openvpn. Credentials saved privately in .env.`,
);
