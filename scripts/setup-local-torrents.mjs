// A separate Transmission queue with its own VPN connection (#911), without changing the shared daemon: the same VPN
// account and region as the existing transmission-openvpn container, read from it, in a tunnel of its own, so PIA's
// forwarded port of that tunnel is Sonder's and its torrents are connectable. Its RPC is published on loopback only.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { OWN_VPN_LABEL, torrentContainerAction } from "./torrent-container.mjs";
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
// The VPN account, region and DNS of the existing container, for a connection of Sonder's own.
const VPN_SETTINGS = [
  "OPENVPN_PROVIDER",
  "OPENVPN_CONFIG",
  "OPENVPN_USERNAME",
  "OPENVPN_PASSWORD",
  "OPENVPN_OPTS",
  "PEER_DNS",
  "PEER_DNS_PIN_ROUTES",
  "OVERRIDE_DNS_1",
  "OVERRIDE_DNS_2",
  "HEALTH_CHECK_HOST",
];
const vpnEnv = Object.fromEntries(
  vpn.Config.Env.map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]).filter(([key]) =>
    VPN_SETTINGS.includes(key),
  ),
);
if (!vpnEnv.OPENVPN_PROVIDER || !vpnEnv.OPENVPN_USERNAME || !vpnEnv.OPENVPN_PASSWORD)
  throw new Error("The transmission-openvpn container names no VPN provider and account to share.");
const RPC_PORT = 9092;
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
  TRANSMISSION_RPC_URL: `http://127.0.0.1:${RPC_PORT}/transmission/rpc`,
  TRANSMISSION_USERNAME: "sonder",
  TRANSMISSION_PASSWORD: password,
  TRANSMISSION_DOWNLOAD_DIR: "/downloads/complete",
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
// The RPC port is published on loopback for Sonder, and on the LAN address named by TRANSMISSION_RPC_LAN_ADDRESS in
// .env (the router's, 192.168.1.1) for a remote GUI on the LAN; Docker's userland proxy puts it behind the router's
// input chain, which takes LAN and WireGuard, never WAN.
const lanAddress = get("TRANSMISSION_RPC_LAN_ADDRESS")?.trim();
if (lanAddress && !/^(\d{1,3}\.){3}\d{1,3}$/.test(lanAddress)) throw new Error("TRANSMISSION_RPC_LAN_ADDRESS must be an IPv4 address.");
const rpcHosts = ["127.0.0.1", ...(lanAddress && lanAddress !== "127.0.0.1" ? [lanAddress] : [])];
const action = existing ? torrentContainerAction(existing, vpn, volumeId, { port: RPC_PORT, hosts: rpcHosts }) : "create";
if (action === "recreate") {
  execFileSync("docker", ["stop", "sonder-torrents"], { stdio: "ignore" });
  execFileSync("docker", ["rm", "sonder-torrents"], { stdio: "ignore" });
  existing = null;
}
if (!existing) {
  // The container's settings, private: the VPN account and the RPC password (the image writes settings.json from them).
  const settings = {
    ...vpnEnv,
    SONDER_MEDIA_VOLUME_ID: volumeId,
    CREATE_TUN_DEVICE: "true",
    PUID: String(process.getuid()),
    PGID: String(process.getgid()),
    // The media drive keeps its owners: nothing is chowned over it.
    GLOBAL_APPLY_PERMISSIONS: "false",
    WEBPROXY_ENABLED: "false",
    LOG_TO_STDOUT: "true",
    TRANSMISSION_HOME: "/config",
    TRANSMISSION_RPC_ENABLED: "true",
    TRANSMISSION_RPC_PORT: String(RPC_PORT),
    TRANSMISSION_RPC_BIND_ADDRESS: "0.0.0.0",
    TRANSMISSION_RPC_AUTHENTICATION_REQUIRED: "true",
    TRANSMISSION_RPC_USERNAME: "sonder",
    TRANSMISSION_RPC_PASSWORD: password,
    TRANSMISSION_RPC_WHITELIST_ENABLED: "false",
    TRANSMISSION_RPC_HOST_WHITELIST_ENABLED: "false",
    TRANSMISSION_DOWNLOAD_DIR: "/downloads/complete",
    TRANSMISSION_INCOMPLETE_DIR: "/downloads/incomplete",
    TRANSMISSION_INCOMPLETE_DIR_ENABLED: "true",
    TRANSMISSION_WATCH_DIR_ENABLED: "false",
    TRANSMISSION_RENAME_PARTIAL_FILES: "true",
    // PIA's port updater sets the peer port to the tunnel's forwarded port; no UPnP, no local peer discovery.
    TRANSMISSION_PORT_FORWARDING_ENABLED: "false",
    TRANSMISSION_PEER_PORT_RANDOM_ON_START: "false",
    TRANSMISSION_LPD_ENABLED: "false",
  };
  const envFile = resolve("data/transmission-vpn.env");
  writeFileSync(envFile, Object.entries(settings).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(envFile, 0o600);
  // The entrypoint of this checkout's scripts, copied beside the settings: the container never depends on a checkout.
  const entrypoint = resolve("data/transmission-entrypoint.sh");
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "torrent-entrypoint.sh"), entrypoint);
  chmodSync(entrypoint, 0o755);
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      "sonder-torrents",
      "--restart",
      "unless-stopped",
      "--label",
      `${OWN_VPN_LABEL}=own`,
      "--cap-add",
      "NET_ADMIN",
      ...rpcHosts.flatMap((host) => ["--publish", `${host}:${RPC_PORT}:${RPC_PORT}`]),
      "--log-opt",
      "max-size=10m",
      "--mount",
      `type=bind,source=${root},target=/downloads`,
      "--mount",
      `type=bind,source=${config},target=/config`,
      "--mount",
      `type=bind,source=${entrypoint},target=/sonder-entrypoint.sh,readonly`,
      "--env-file",
      envFile,
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
  if (action === "start")
    execFileSync("docker", ["start", "sonder-torrents"], { stdio: "ignore" });
}
console.log(
  `Sonder torrent queue is configured. Media: ${root}. VPN: its own ${vpnEnv.OPENVPN_PROVIDER} connection (${vpnEnv.OPENVPN_CONFIG || "default region"}), RPC on ${rpcHosts.map((host) => `${host}:${RPC_PORT}`).join(" and ")}. Credentials saved privately in .env and data/transmission-vpn.env.`,
);
