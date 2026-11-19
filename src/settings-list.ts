// Settings as a list (spec #572, "Settings"; boards Settings.dc.html, DesktopSettings.dc.html): which rows each
// account sees, in which group, and the value each row shows. Pure: plain data in, rows out, for the unit tests.
import type { SettingsPage } from "./routes";
import type { Appearance } from "./appearance";
import { formatSpeed } from "./playback-speed";
import { freeSpace } from "./settings-server";

export type SettingsListInput = {
  user: { username: string; role: "admin" | "user" };
  /** `GET /api/settings`, null until it answers. */
  settings: {
    torboxConfigured: boolean;
    hardcoverConfigured: boolean;
    prowlarrConfigured?: boolean;
    storage?: { connected: boolean; usedBytes: number | null; totalBytes: number | null } | null;
  } | null;
  appearance: Pick<Appearance, "preset" | "colors">;
  /** The default speed in use. */
  speed: number;
  /** How many accounts the server has; null until the administrator's list answers. */
  accounts: number | null;
  /** The app runs installed (standalone). */
  installed: boolean;
};
export type SettingsRow = { page: SettingsPage; label: string; value: string };
export type SettingsGroup = { caption: "Personal" | "Server" | "This device"; rows: SettingsRow[] };

export const PAGE_TITLES: Record<SettingsPage, string> = {
  account: "Account",
  appearance: "Appearance",
  playback: "Playback",
  connections: "Connections",
  users: "Users",
  library: "Library and storage",
  app: "App",
};

export const PRESET_NAMES: Record<Appearance["preset"], string> = {
  forest: "Forest",
  charcoal: "Charcoal",
  amoled: "AMOLED",
  contrast: "High contrast",
  light: "Light",
  system: "System",
};

/** The theme as the Appearance row and the Theme picker name it: a preset, or Custom colours over one. */
export function themeName(appearance: Pick<Appearance, "preset" | "colors">): string {
  return Object.values(appearance.colors ?? {}).some(Boolean) ? "Custom colours" : PRESET_NAMES[appearance.preset];
}

/** The services connected, as the Connections row says them; Hardcover only for someone who is not the administrator. */
export function connectionsValue(settings: SettingsListInput["settings"], admin: boolean): string {
  if (!settings) return "";
  const names = admin
    ? [
        settings.torboxConfigured && "TorBox",
        settings.hardcoverConfigured && "Hardcover",
        settings.prowlarrConfigured && "Prowlarr",
      ]
    : [settings.hardcoverConfigured && "Hardcover"];
  const connected = names.filter((name): name is string => !!name);
  return connected.length ? connected.join(", ") : "Not connected";
}

/** The free space on the media drive, when the server reports its sizes. */
export function storageValue(settings: SettingsListInput["settings"]): string {
  const storage = settings?.storage;
  if (!storage) return "";
  if (!storage.connected) return "Not connected";
  return freeSpace(storage) ?? "";
}

export function settingsList(input: SettingsListInput): SettingsGroup[] {
  const admin = input.user.role === "admin";
  const personal: SettingsRow[] = [
    { page: "account", label: PAGE_TITLES.account, value: `${input.user.username} · ${admin ? "Admin" : "User"}` },
    { page: "appearance", label: PAGE_TITLES.appearance, value: themeName(input.appearance) },
    { page: "playback", label: PAGE_TITLES.playback, value: `${formatSpeed(input.speed)}×` },
  ];
  const connections: SettingsRow = { page: "connections", label: PAGE_TITLES.connections, value: connectionsValue(input.settings, admin) };
  const device: SettingsGroup = {
    caption: "This device",
    rows: [{ page: "app", label: PAGE_TITLES.app, value: input.installed ? "Installed" : "Install" }],
  };
  if (!admin) return [{ caption: "Personal", rows: [...personal, connections] }, device];
  return [
    { caption: "Personal", rows: personal },
    {
      caption: "Server",
      rows: [
        connections,
        {
          page: "users",
          label: PAGE_TITLES.users,
          value: input.accounts === null ? "" : `${input.accounts} account${input.accounts === 1 ? "" : "s"}`,
        },
        { page: "library", label: PAGE_TITLES.library, value: storageValue(input.settings) },
      ],
    },
    device,
  ];
}
