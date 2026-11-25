/**
 * Kept prepared text on this device (#805): saving it for Keep on this device, reading it when the server does not
 * answer, and removing it. The rules are `keep-text.ts`; this file holds the Cache Storage, the device database and
 * the requests.
 *
 * The server must not import this file: the production image copies only five files of `src/`.
 */
import type { PreparedManifest } from "../server/prepared-text";
import { EBOOK_DEVICE_EVENT } from "./ebook-keep";
import type { HeldText } from "./keep";
import { readerTextKey } from "./keep";
import {
  KEPT_TEXT_CACHE,
  belongsToEdition,
  keptManifestAddress,
  keptTextMatches,
  noticeAnswer,
  partAddress,
  pictureAddress,
  pictureNames,
  preparedAddress,
  preparedBase,
  replacedOutput,
  textSaveRefused,
  type KeptTextRecord,
} from "./keep-text";
import { api, authDB, localDB } from "./lib";

const changed = (id: string) => window.dispatchEvent(new CustomEvent(EBOOK_DEVICE_EVENT, { detail: { id } }));

/** The kept cache, or null where the page has no Cache Storage (an insecure origin). */
async function keptCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  return caches.open(KEPT_TEXT_CACHE).catch(() => null);
}

async function readRecord(id: string): Promise<KeptTextRecord | null> {
  return (((await authDB.preferences.get(readerTextKey(id)).catch(() => undefined))?.value as KeptTextRecord | undefined) ?? null);
}

/** A failed answer as the saver classes it (`textSaveRefused`): a refusal waits for Retry; a 401 is a sign-out. */
function refusal(message: string, status: number) {
  const refused = textSaveRefused(status);
  return Object.assign(new Error(message), { refused, status, ...(refused ? { failure: status === 401 ? "signed-out" : "source" } : {}) });
}

/**
 * Keeps an EPUB's prepared text on this device (#805): the manifest the server answers now, then every part and every
 * picture the parts show, each stored in the kept cache under its own address; a file already there from an
 * interrupted save is not asked for again. The record is written last, so a save that stopped leaves none, and the
 * files of an output it replaces are removed after it.
 */
export async function keepText(ebookId: string, signal: AbortSignal): Promise<void> {
  const cache = await keptCache();
  if (!cache) throw Object.assign(new Error("This browser cannot keep the book's text."), { refused: true, failure: "source" });
  const manifestResponse = await fetch(preparedAddress(ebookId), { signal, cache: "no-cache" });
  if (!manifestResponse.ok) throw refusal("The book's text could not be saved on this device.", manifestResponse.status);
  const manifestText = await manifestResponse.text();
  const manifest = JSON.parse(manifestText) as PreparedManifest;
  const base = preparedBase(ebookId, manifest.key);
  let size = new Blob([manifestText]).size;
  /** One file of the output: from the kept cache when an earlier save stored it, otherwise asked for and stored. */
  const file = async (address: string): Promise<Blob> => {
    const kept = await cache.match(address);
    if (kept) return kept.blob();
    const response = await fetch(address, { signal });
    if (!response.ok) {
      const answer = (await response.json().catch(() => ({}))) as { code?: string };
      // Prepared again while this save ran: the next run asks for the new manifest.
      if (answer.code === "prepared_stale") throw new TypeError("The book's text changed while it was saved.");
      throw refusal("The book's text could not be saved on this device.", response.status);
    }
    const blob = await response.blob();
    signal.throwIfAborted();
    await cache.put(address, new Response(blob, { headers: { "Content-Type": response.headers.get("Content-Type") || blob.type } }));
    return blob;
  };
  const pictures = new Set<string>();
  for (const part of manifest.parts) {
    signal.throwIfAborted();
    const blob = await file(partAddress(base, part.index));
    size += blob.size;
    for (const name of pictureNames(await blob.text(), base)) pictures.add(name);
  }
  for (const name of pictures) {
    signal.throwIfAborted();
    size += (await file(pictureAddress(base, name))).size;
  }
  signal.throwIfAborted();
  // What the user saved, so the book opens offline without the EPUB's details too (`loadPreparedReader`).
  const state = await api(`/reader/${encodeURIComponent(ebookId)}/state`, { signal }).catch(() => null);
  if (state) await localDB.preferences.put({ key: `reader-state:${ebookId}`, value: state }).catch(() => {});
  // The manifest under its own output's address: the record that names an earlier output still finds its own.
  await cache.put(keptManifestAddress(base), new Response(manifestText, { headers: { "Content-Type": "application/json; charset=utf-8" } }));
  const record: KeptTextRecord = { id: ebookId, key: manifest.key, fingerprint: manifest.fingerprint, parts: manifest.parts.length, pictures: [...pictures], size, at: Date.now() };
  await authDB.preferences.put({ key: readerTextKey(ebookId), value: record });
  // The output this one replaces goes now that the new one is whole.
  for (const request of await cache.keys()) {
    if (replacedOutput(new URL(request.url).pathname, ebookId, manifest.key)) await cache.delete(request);
  }
  changed(ebookId);
}

/**
 * The kept manifest of an edition, when this device keeps its text whole; null otherwise. The reader opens it when
 * the server does not answer; a stale one still reads, as its parts are kept with it.
 */
export async function keptManifest(id: string): Promise<PreparedManifest | null> {
  const record = await readRecord(id);
  if (!record) return null;
  const cache = await keptCache();
  const response = await cache?.match(keptManifestAddress(preparedBase(id, record.key))).catch(() => undefined);
  if (!response) return null;
  const manifest = (await response.json().catch(() => null)) as PreparedManifest | null;
  return manifest && keptTextMatches(record, manifest) ? manifest : null;
}

/** The output this device keeps of an edition (its key), or null: the reader looks for its parts here only then. */
export async function keptTextKey(id: string): Promise<string | null> {
  return (await readRecord(id))?.key ?? null;
}

/** A kept part's HTML by its address, or null: the reader reads a kept book's parts from here before the server. */
export async function keptPart(address: string): Promise<string | null> {
  const response = await (await keptCache())?.match(address).catch(() => undefined);
  return response ? response.text() : null;
}

/**
 * The server answered a manifest for an edition: a kept text of another output is marked stale (#805), and the next
 * run of Keep saves the new one in its place. Nothing when this device keeps no text of it.
 */
export async function noticePreparedAnswer(id: string, manifest: Pick<PreparedManifest, "key" | "fingerprint">): Promise<void> {
  const record = await readRecord(id);
  if (noticeAnswer(record, manifest) !== "stale") return;
  await authDB.preferences.put({ key: readerTextKey(id), value: { ...record!, stale: true } });
  changed(id);
}

/** Every kept text on this device, as Keep reads them (#805). A record whose manifest the cache lost is not one. */
export async function listKeptTexts(ids?: readonly string[]): Promise<HeldText[]> {
  const rows = ids
    ? (await authDB.preferences.bulkGet(ids.map(readerTextKey)).catch(() => [])).filter((row) => !!row)
    : await authDB.preferences.where("key").startsWith("reader-text:").toArray().catch(() => []);
  if (!rows.length) return [];
  const cache = await keptCache();
  const held: HeldText[] = [];
  for (const row of rows) {
    const record = row!.value as KeptTextRecord;
    if (!record?.key || !(await cache?.match(keptManifestAddress(preparedBase(record.id, record.key))).catch(() => undefined))) continue;
    held.push({ id: record.id, key: record.key, fingerprint: record.fingerprint, size: record.size, ...(record.stale ? { stale: true } : {}) });
  }
  return held;
}

/** The bytes of an edition's kept text, or null when this device keeps none. */
export async function keptTextSize(id: string): Promise<number | null> {
  return (await listKeptTexts([id]))[0]?.size ?? null;
}

/** Removes an edition's kept text from this device: its record first, then every file of every output of it. */
export async function removeKeptText(id: string): Promise<void> {
  const had = await readRecord(id);
  await authDB.preferences.delete(readerTextKey(id));
  const cache = await keptCache();
  let removed = false;
  if (cache)
    for (const request of await cache.keys()) {
      if (!belongsToEdition(new URL(request.url).pathname, id)) continue;
      await cache.delete(request);
      removed = true;
    }
  if (had || removed) changed(id);
}
