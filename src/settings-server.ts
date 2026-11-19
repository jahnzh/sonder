// The lines of the Server pages of Settings (#580; spec #572 "Connections", "Users", "Library and storage"; boards
// DesktopSettings.dc.html, SettingsUsers.dc.html, SettingsLibrary.dc.html). Pure: plain data in, words out, for the
// unit tests.
import type { Settings } from "./types";

type Storage = NonNullable<Settings["storage"]>;

const UNITS = [
  [1e12, "TB"],
  [1e9, "GB"],
  [1e6, "MB"],
  [1e3, "KB"],
] as const;

/** One decimal below ten, none from ten up, no ".0", as the boards write sizes ("2.9", "4", "12"). */
function figure(value: number) {
  return value >= 9.95 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

/** A drive's size in its own unit, terabytes included: "4 TB", "1.1 TB", "640 GB". */
export function driveSize(n: number): { figure: string; unit: string } {
  const [scale, unit] = UNITS.find(([scale]) => n >= scale) ?? UNITS[UNITS.length - 1];
  return { figure: figure(n / scale), unit };
}
const sized = (n: number) => {
  const { figure, unit } = driveSize(n);
  return `${figure} ${unit}`;
};

/** The free space, as the list's Library and storage row says it: "1.1 TB free". */
export function freeSpace(storage: Storage): string | null {
  if (!storage.connected || storage.usedBytes === null || storage.totalBytes === null) return null;
  return `${sized(Math.max(0, storage.totalBytes - storage.usedBytes))} free`;
}

/** The Used row: "2.9 of 4 TB · 1.1 TB free" (the unit once when both share it), or null without sizes. */
export function usedLine(storage: Storage): string | null {
  const free = freeSpace(storage);
  if (free === null) return null;
  const used = driveSize(storage.usedBytes!);
  const total = driveSize(storage.totalBytes!);
  const share = used.unit === total.unit ? `${used.figure} of ${total.figure} ${total.unit}` : `${used.figure} ${used.unit} of ${total.figure} ${total.unit}`;
  return `${share} · ${free}`;
}

/** The share of the drive in use, 0 to 1, for the Used row's bar; null without sizes. */
export function usedShare(storage: Storage): number | null {
  if (!storage.connected || storage.usedBytes === null || !storage.totalBytes) return null;
  return Math.min(1, Math.max(0, storage.usedBytes / storage.totalBytes));
}

export const MEDIA_DRIVE_CONNECTED = "Connected";
export const MEDIA_DRIVE_NOT_CONNECTED = "Not connected";

/** How long ago an account request was sent: "just now", "5 minutes ago", "2 hours ago", "3 days ago", or its day. */
export function requestAge(createdAt: number, now: number): string {
  const minutes = Math.round((now - createdAt) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(createdAt).toLocaleDateString();
}

/** The line after Approve: whether the invite email went out. */
export function approvedLine(username: string, delivered: boolean): string {
  return delivered ? `Approved ${username}. The invite email was sent.` : `Approved ${username}. The invite email was not sent.`;
}

export const APPROVING_NOTE = "Approving sends an invite link by email. The link works for 7 days.";
export const NO_REQUESTS = "No account requests";
export const KEYS_ENCRYPTED = "Connection keys are stored encrypted on your server.";
