/**
 * The prepared text a kept book keeps on this device (#805, step 6 of #799): the rules, as plain data.
 *
 * Keep on this device keeps an EPUB's prepared output (ADR 0025): its manifest, every part and every picture, under
 * the addresses the server serves them at, in the Cache Storage cache `KEPT_TEXT_CACHE`; the service worker answers a
 * part or a picture from there before asking the server (their addresses name the output's key and never change),
 * and the reader takes the manifest from there when the server does not answer. A record `reader-text:<id>` in the
 * shared device database says the output is whole: it is written after every file is in the cache.
 *
 * No React, no `window`, no Dexie, no fetch. The server must not import this file: the production image copies only
 * five files of `src/`.
 */
import type { PreparedManifest } from "../server/prepared-text";
import { allowedPictureAddress } from "./prepared-text-rules";

/**
 * The cache of kept prepared text. Its name starts neither with `sonder-shell-` nor `sonder-stream-`, so Reset this
 * device leaves it, as it leaves the books kept on this device. `public/sw.js` names it too.
 */
export const KEPT_TEXT_CACHE = "sonder-kept-text-v1";

/** The record of an edition's kept prepared text (`reader-text:<id>` of the shared device database). */
export type KeptTextRecord = {
  id: string;
  /** The prepared output kept: its key names every address of it. */
  key: string;
  /** The EPUB file it was made from (the manifest's `fingerprint`). */
  fingerprint: string;
  /** How many parts and which pictures were kept. */
  parts: number;
  pictures: string[];
  /** Bytes of the manifest, the parts and the pictures. */
  size: number;
  /** When it was kept. */
  at: number;
  /** The reader saw the server answer another output: this one still reads, and the next run of Keep replaces it. */
  stale?: boolean;
};

/** The manifest's address: what `GET /api/reader/<edition>/prepared` answers. */
export const preparedAddress = (id: string) => `/api/reader/${encodeURIComponent(id)}/prepared`;
/** The address one prepared output is served under (`PreparedBook.base`). */
export const preparedBase = (id: string, key: string) => `${preparedAddress(id)}/${key}`;
export const partAddress = (base: string, index: number) => `${base}/parts/${index}`;
export const pictureAddress = (base: string, name: string) => `${base}/pictures/${name}`;

/**
 * The pictures a part shows, by name, in order and once each: the `src` of its pictures under `base`, as the server
 * writes them (`preparedPictureAddress`). Any other address is not the book's and is not kept.
 */
export function pictureNames(html: string, base: string): string[] {
  const names = new Set<string>();
  for (const found of html.matchAll(/\ssrc="([^"]*)"/g)) {
    const src = found[1]!.replace(/&amp;/g, "&");
    if (allowedPictureAddress(src, base)) names.add(src.slice(`${base}/pictures/`.length));
  }
  return [...names];
}

/**
 * Whether a kept record is whole for the manifest it names: every part counted and the output's key and file the
 * manifest's. A record that does not match its manifest is not one to read from.
 */
export function keptTextMatches(record: Pick<KeptTextRecord, "key" | "fingerprint" | "parts"> | null | undefined, manifest: Pick<PreparedManifest, "key" | "fingerprint" | "parts">): boolean {
  return !!record && record.key === manifest.key && record.fingerprint === manifest.fingerprint && record.parts === manifest.parts.length;
}

/**
 * What a manifest the server answered says of the kept record (#805): `stale` when it names another output (the
 * book's file changed, or the server prepares it anew), so the next run of Keep saves that one in its place; null
 * when the record is current or there is none.
 */
export function noticeAnswer(record: Pick<KeptTextRecord, "key" | "fingerprint" | "stale"> | null | undefined, manifest: Pick<PreparedManifest, "key" | "fingerprint">): "stale" | null {
  if (!record || record.stale) return null;
  return record.key === manifest.key && record.fingerprint === manifest.fingerprint ? null : "stale";
}

/** Whether a cached address is part of an edition's kept text, whatever its output (manifest, part or picture). */
export function belongsToEdition(pathname: string, id: string): boolean {
  const own = preparedAddress(id);
  return pathname === own || pathname.startsWith(`${own}/`);
}

/** Whether a cached address is one of an edition's kept text but of another output than `key`: a replaced one. */
export function replacedOutput(pathname: string, id: string, key: string): boolean {
  return pathname.startsWith(`${preparedAddress(id)}/`) && !pathname.startsWith(`${preparedBase(id, key)}/`);
}
