// The book's Edit page (#719 part a): fields edited by hand, kept in Sonder only (the files are never written).
//
// - An edited field is one row of `work_metadata_overrides` (per work) or `recording_metadata_overrides` (a recording's
//   narrators), its value as JSON. On every read it wins over the stored value and over the catalogue's: a refresh or
//   a match writes `works`/`audio_editions` and the links, never these rows, so what was edited by hand stays.
// - Revert deletes the row: the source's value (the import's, or what a match filled in) shows again.
// - A value saved equal to the source's is not kept as an edit: the field is not shown as Edited.
// - Series: the work's `series` field replaces the series read from the catalogue. An entry is an AudiobookDB series
//   (its id, picked by #721's series search) or a local series (`local_series`, id `local-<n>`), each with a position.
//   The Series pages read both (`localSeriesList`, `localSeriesAnswer`, and `handSeriesRows` in series-catalogue.ts).
// - Cover: an https address (a pasted one, or a provider's, shown by URL and never downloaded, #721's licence rule), or
//   an uploaded image kept under `MEDIA_ROOT/covers` and served by `GET /api/covers/<file>`.
// - Only the administrator edits; everyone reads the edited values (the catalogue is shared).
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sqlite } from "./db.ts";
import { mediaMountProblem, mediaRoot } from "./storage.ts";
import { currentUserId, requireAdmin } from "./users.ts";
import { idList } from "./work-cover.ts";
import { CATALOGUE_PROVIDERS, type CatalogueProviderName } from "./catalogue-provider.ts";
import {
  WORK_FIELDS,
  type LibraryWork,
  type SeriesEntry,
  type WorkDetails,
  type WorkField,
  type WorkFieldValues,
  type WorkMetadata,
  type WorkSeries,
} from "../src/types.ts";

/** Names as one text holds them ("A, B & C"; "A; B"): one by one, trimmed, without empties or repeats. */
export function splitNames(text: string | null | undefined): string[] {
  const names = String(text ?? "")
    .split(/\s*(?:[,;&]|\s\/\s)\s*/)
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(names)];
}
export const joinNames = (names: string[]) => names.join(", ");

/** A stored JSON value; undefined when the text is not JSON. */
function storedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

type Overrides = Map<string, Partial<Record<WorkField, unknown>>>;

/** The edited fields of `workIds`, by work. */
export function workOverrides(workIds: string[]): Overrides {
  const byWork: Overrides = new Map();
  if (!workIds.length) return byWork;
  const rows = sqlite
    .prepare("SELECT work_id AS workId,field,value FROM work_metadata_overrides WHERE work_id IN (SELECT value FROM json_each(?))")
    .all(idList(workIds)) as { workId: string; field: string; value: string }[];
  for (const row of rows) {
    if (!(WORK_FIELDS as readonly string[]).includes(row.field)) continue;
    const entry = byWork.get(row.workId) ?? {};
    const value = storedJson(row.value);
    // A value that is not JSON was never written by this module: the source's value shows.
    if (value === undefined) continue;
    entry[row.field as WorkField] = value;
    byWork.set(row.workId, entry);
  }
  return byWork;
}

const providerName = (value: unknown): CatalogueProviderName | null =>
  typeof value === "string" && (CATALOGUE_PROVIDERS as readonly string[]).includes(value) ? (value as CatalogueProviderName) : null;
/** The provider each edited field of a work was taken from by a match (#719 part b); a field edited by hand is absent. */
export function overrideSources(workId: string): Partial<Record<WorkField, CatalogueProviderName>> {
  const rows = sqlite.prepare("SELECT field,source FROM work_metadata_overrides WHERE work_id=? AND source IS NOT NULL").all(workId) as { field: string; source: string }[];
  const out: Partial<Record<WorkField, CatalogueProviderName>> = {};
  for (const row of rows) {
    const name = providerName(row.source);
    if (name && (WORK_FIELDS as readonly string[]).includes(row.field)) out[row.field as WorkField] = name;
  }
  return out;
}
function narratorSources(recordingIds: string[]): Map<string, CatalogueProviderName> {
  if (!recordingIds.length) return new Map();
  const rows = sqlite
    .prepare("SELECT recording_id AS recordingId,source FROM recording_metadata_overrides WHERE field='narrators' AND source IS NOT NULL AND recording_id IN (SELECT value FROM json_each(?))")
    .all(idList(recordingIds)) as { recordingId: string; source: string }[];
  return new Map(rows.flatMap((row) => (providerName(row.source) ? [[row.recordingId, providerName(row.source)!] as const] : [])));
}

/** The edited narrators of `recordingIds`, by recording. */
export function recordingNarrators(recordingIds: string[]): Map<string, string[]> {
  if (!recordingIds.length) return new Map();
  const rows = sqlite
    .prepare("SELECT recording_id AS recordingId,value FROM recording_metadata_overrides WHERE field='narrators' AND recording_id IN (SELECT value FROM json_each(?))")
    .all(idList(recordingIds)) as { recordingId: string; value: string }[];
  const map = new Map<string, string[]>();
  for (const row of rows) {
    // Anything but a list was not written by this module: the source's narrators show.
    const value = storedJson(row.value);
    if (Array.isArray(value)) map.set(row.recordingId, value.map(String));
  }
  return map;
}

/** What the source gives besides the work's own row: the language of its audio editions and the ASIN of a release link. */
function extraSources(workIds: string[]) {
  const rows = sqlite
    .prepare(
      `SELECT w.value AS workId,
         (SELECT e.language FROM audio_editions e WHERE e.work_id=w.value AND e.language IS NOT NULL AND e.language<>'' ORDER BY e.rowid LIMIT 1) AS language,
         (SELECT l.asin FROM recording_release_links l JOIN recordings r ON r.id=l.recording_id JOIN audio_editions e ON e.id=r.edition_id
            WHERE e.work_id=w.value AND l.asin IS NOT NULL ORDER BY l.linked_at LIMIT 1) AS asin
       FROM json_each(?) w`,
    )
    .all(idList(workIds)) as { workId: string; language: string | null; asin: string | null }[];
  return new Map(rows.map((row) => [row.workId, row]));
}

const localNames = (ids: string[]) =>
  new Map(
    (ids.length
      ? (sqlite.prepare("SELECT id,name FROM local_series WHERE id IN (SELECT value FROM json_each(?))").all(idList(ids)) as { id: string; name: string }[])
      : []
    ).map((row) => [row.id, row.name]),
  );

/** A stored series list as the work's series: local names as `local_series` holds them; `saved` is the user's. */
function seriesOf(entries: unknown, saved: Set<string>): WorkSeries[] {
  if (!Array.isArray(entries)) return [];
  const list = entries as SeriesEntry[];
  const names = localNames(list.filter((entry) => entry.local && entry.id).map((entry) => entry.id!));
  return list.map((entry) => ({
    id: entry.id,
    name: (entry.local && entry.id && names.get(entry.id)) || entry.name,
    position: entry.position,
    positionLabel: entry.positionLabel,
    saved: !entry.local && !!entry.id && saved.has(entry.id),
    ...(entry.local ? { local: true } : {}),
  }));
}

const asEntry = (series: WorkSeries): SeriesEntry => ({
  id: series.id,
  name: series.name,
  position: series.position,
  positionLabel: series.positionLabel ?? (series.position != null ? String(series.position) : null),
  local: !!series.local,
});

/** The source's values of a work as built without edits (`LibraryWork`) and what the source gives besides. */
export function sourceValues(work: LibraryWork, extra?: { language: string | null; asin: string | null }): WorkFieldValues {
  const recording = work.recordings.find((entry) => entry.recordingId === work.chosenRecordingId) ?? work.recordings[0];
  return {
    title: work.title,
    subtitle: "",
    authors: splitNames(work.author),
    series: work.series.map(asEntry),
    genres: splitNames(work.genre),
    tags: [],
    publisher: "",
    year: work.year || null,
    language: recording?.language || extra?.language || "",
    isbn: "",
    asin: extra?.asin || "",
    description: work.description,
    abridged: null,
    explicit: null,
    cover: work.cover,
  };
}

/** The values with the edits applied, and which fields were edited. */
function editedValues(source: WorkFieldValues, overrides: Partial<Record<WorkField, unknown>> | undefined, saved: Set<string>) {
  const values = { ...source } as Record<WorkField, unknown>;
  const edited: WorkField[] = [];
  for (const field of WORK_FIELDS) {
    if (!overrides || !(field in overrides)) continue;
    values[field] = field === "series" ? seriesOf(overrides.series, saved).map(asEntry) : overrides[field];
    edited.push(field);
  }
  return { values: values as WorkFieldValues, edited };
}

/**
 * The works as `buildWorks` made them from the stored values, with the edits applied in place: the first fields
 * (title, author, genre, year, description, cover, series), the recordings' narrators, and `details`.
 */
export function applyWorkEdits(works: LibraryWork[], saved: Set<string>): LibraryWork[] {
  if (!works.length) return works;
  const ids = works.map((work) => work.workId);
  const overrides = workOverrides(ids);
  const extras = extraSources(ids);
  const narrators = recordingNarrators(works.flatMap((work) => work.recordings.map((recording) => recording.recordingId)));
  for (const work of works) {
    const source = sourceValues(work, extras.get(work.workId));
    const own = overrides.get(work.workId);
    const { values, edited } = editedValues(source, own, saved);
    work.title = values.title;
    work.author = joinNames(values.authors);
    work.genre = joinNames(values.genres);
    work.year = values.year ?? 0;
    work.description = values.description;
    work.cover = values.cover;
    if (own && "series" in own) work.series = seriesOf(own.series, saved);
    const details: WorkDetails = {
      subtitle: values.subtitle,
      authors: values.authors,
      genres: values.genres,
      tags: values.tags,
      publisher: values.publisher,
      language: values.language,
      isbn: values.isbn,
      asin: values.asin,
      abridged: values.abridged,
      explicit: values.explicit,
      edited,
    };
    work.details = details;
    for (const recording of work.recordings) {
      const names = narrators.get(recording.recordingId);
      if (names) recording.narrator = joinNames(names);
      recording.narrators = names ?? splitNames(recording.narrator);
      recording.narratorsEdited = !!names;
    }
  }
  return works;
}

/** The Edit page's answer for a work built without edits (`buildWorks(..., { edits: false })`). */
export function metadataOf(raw: LibraryWork, saved: Set<string>): WorkMetadata {
  const source = sourceValues(raw, extraSources([raw.workId]).get(raw.workId));
  const { values, edited } = editedValues(source, workOverrides([raw.workId]).get(raw.workId), saved);
  const recordingIds = raw.recordings.map((recording) => recording.recordingId);
  const narrators = recordingNarrators(recordingIds);
  const takenFrom = narratorSources(recordingIds);
  const from = overrideSources(raw.workId);
  return {
    workId: raw.workId,
    values,
    source,
    edited,
    // Only the fields still edited: a field whose edit went has no provider to name.
    from: Object.fromEntries(Object.entries(from).filter(([field]) => edited.includes(field as WorkField))),
    recordings: raw.recordings.map((recording) => {
      const own = splitNames(recording.narrator);
      const names = narrators.get(recording.recordingId);
      return {
        recordingId: recording.recordingId,
        label: recording.releaseTitle || recording.sourceLabel || own.join(", ") || "Recording",
        narrators: names ?? own,
        source: own,
        edited: !!names,
        from: names ? takenFrom.get(recording.recordingId) ?? null : null,
      };
    }),
  };
}

/** Title and author of `rows` with the edits applied (Discover's read of the server's works). */
export function applyTitleEdits<T extends { id: string; title: string; author: string }>(rows: T[]): T[] {
  const overrides = workOverrides(rows.map((row) => row.id));
  if (!overrides.size) return rows;
  return rows.map((row) => {
    const own = overrides.get(row.id);
    if (!own) return row;
    return {
      ...row,
      ...(typeof own.title === "string" ? { title: own.title } : {}),
      ...(Array.isArray(own.authors) ? { author: joinNames(own.authors as string[]) } : {}),
    };
  });
}

// ---- Writing ----
const text = (max: number) => z.string().trim().max(max);
const names = z.array(text(200).min(1)).max(50).transform((list) => [...new Set(list)]);
const coverValue = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => value === "" || /^https:\/\/[^\s]+$/.test(value) || /^\/api\/covers\/[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/.test(value) || /^\/covers\/[a-z0-9-]+\.svg$/.test(value), "Use an https address for the cover.");
const seriesInput = z
  .object({
    id: z.string().trim().max(200).regex(/^[A-Za-z0-9_.:-]+$/).nullable().optional(),
    name: text(300).min(1, "Name the series."),
    position: z.number().finite().min(0).max(100000).nullable().optional(),
    positionLabel: text(40).nullable().optional(),
    local: z.boolean().optional(),
  })
  .strip();
export const fieldInputs = {
  title: text(500).min(1, "A book needs a title."),
  subtitle: text(500),
  authors: names,
  series: z.array(seriesInput).max(20),
  genres: names,
  tags: names,
  publisher: text(300),
  year: z.number().int().min(0).max(3000).nullable(),
  language: text(60),
  isbn: text(20).regex(/^[0-9Xx -]*$/, "An ISBN has digits only (and X)."),
  asin: text(10).regex(/^(?:[A-Za-z0-9]{10})?$/, "An ASIN has 10 letters and digits.").transform((value) => value.toUpperCase()),
  description: z.string().max(20000),
  abridged: z.boolean().nullable(),
  explicit: z.boolean().nullable(),
  cover: coverValue,
} satisfies Record<WorkField, z.ZodTypeAny>;

let localCounter = 0;
/** The local series named `name` (case and spaces ignored), made when there is none. */
export function localSeriesNamed(name: string): { id: string; name: string } {
  const clean = name.trim().replace(/\s+/g, " ");
  const found = sqlite.prepare("SELECT id,name FROM local_series WHERE lower(name)=lower(?) ORDER BY created_at,id LIMIT 1").get(clean) as { id: string; name: string } | undefined;
  if (found) return found;
  const id = `local-${Date.now().toString(36)}${(localCounter++).toString(36)}${createHash("sha256").update(`${clean}\n${Math.random()}`).digest("hex").slice(0, 6)}`;
  sqlite.prepare("INSERT INTO local_series(id,name,created_at) VALUES(?,?,?)").run(id, clean, Date.now());
  return { id, name: clean };
}

/** A series list as given, stored: a local entry (or one without an id) is the local series of its name. */
function storedSeries(list: z.infer<typeof fieldInputs.series>): SeriesEntry[] {
  const seen = new Set<string>();
  const out: SeriesEntry[] = [];
  for (const entry of list) {
    const local = entry.local || !entry.id || entry.id.startsWith("local-");
    const named = local ? localSeriesNamed(entry.name) : { id: entry.id!, name: entry.name.trim() };
    if (seen.has(named.id)) continue;
    seen.add(named.id);
    const position = entry.position ?? null;
    out.push({ id: named.id, name: named.name, position, positionLabel: entry.positionLabel || (position != null ? String(position) : null), local });
  }
  return out;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Writes the edits of one work: each field of `values` is kept as edited unless it equals the source's value, in
 * which case its edit goes; each field of `revert` loses its edit. Returns the fields written.
 */
export function writeWorkEdits(workId: string, source: WorkFieldValues, values: Record<string, unknown>, revert: WorkField[], from: CatalogueProviderName | null = null) {
  const now = Date.now();
  // `from`: the provider a match took the values from (#719 part b); null for an edit by hand.
  const put = sqlite.prepare(
    "INSERT INTO work_metadata_overrides(work_id,field,value,edited_at,source) VALUES(?,?,?,?,?) ON CONFLICT(work_id,field) DO UPDATE SET value=excluded.value,edited_at=excluded.edited_at,source=excluded.source",
  );
  const drop = sqlite.prepare("DELETE FROM work_metadata_overrides WHERE work_id=? AND field=?");
  sqlite.transaction(() => {
    for (const field of revert) drop.run(workId, field);
    for (const field of WORK_FIELDS) {
      if (!(field in values)) continue;
      const parsed = fieldInputs[field].parse(values[field]);
      const value = field === "series" ? storedSeries(parsed as z.infer<typeof fieldInputs.series>) : parsed;
      const compared = field === "series" ? (value as SeriesEntry[]).map(({ id, position }) => ({ id, position })) : value;
      const sourced = field === "series" ? source.series.map(({ id, position }) => ({ id, position })) : source[field];
      if (sameValue(compared, sourced)) drop.run(workId, field);
      else put.run(workId, field, JSON.stringify(value), now, from);
    }
  })();
}

/** Writes or reverts (null) a recording's narrators; the source's narrators are not kept as an edit. */
export function writeNarrators(recordingId: string, source: string[], narrators: string[] | null, from: CatalogueProviderName | null = null) {
  if (narrators === null || sameValue(narrators, source))
    sqlite.prepare("DELETE FROM recording_metadata_overrides WHERE recording_id=? AND field='narrators'").run(recordingId);
  else
    sqlite
      .prepare(
        "INSERT INTO recording_metadata_overrides(recording_id,field,value,edited_at,source) VALUES(?,'narrators',?,?,?) ON CONFLICT(recording_id,field) DO UPDATE SET value=excluded.value,edited_at=excluded.edited_at,source=excluded.source",
      )
      .run(recordingId, JSON.stringify(narrators), Date.now(), from);
}

// ---- Local series on the Series pages ----
/** The works whose edited series list holds `seriesId`, with the entry's position. */
export function handSeriesMembers(seriesId: string): { workId: string; position: number | null; positionLabel: string | null }[] {
  const rows = sqlite
    .prepare(
      `SELECT o.work_id AS workId,json_extract(j.value,'$.position') AS position,json_extract(j.value,'$.positionLabel') AS positionLabel
       FROM work_metadata_overrides o, json_each(o.value) j
       WHERE o.field='series' AND json_valid(o.value) AND json_extract(j.value,'$.id')=?
       ORDER BY position IS NULL,position,o.work_id`,
    )
    .all(seriesId) as { workId: string; position: number | null; positionLabel: string | null }[];
  return rows;
}
/** Whether the work's series were edited by hand, and the list then (the catalogue's series do not count for it). */
export function handSeriesOf(workId: string): SeriesEntry[] | null {
  const own = workOverrides([workId]).get(workId);
  return own && Array.isArray(own.series) ? (own.series as SeriesEntry[]) : null;
}
export const isLocalSeriesId = (id: string) => /^local-[a-z0-9]{1,40}$/.test(id);
export function localSeriesHead(id: string) {
  return (sqlite.prepare("SELECT id,name FROM local_series WHERE id=?").get(id) as { id: string; name: string } | undefined) ?? null;
}
/** Every local series with a member work. */
export function localSeriesIds(): string[] {
  return sqlite
    .prepare(
      `SELECT DISTINCT json_extract(j.value,'$.id') FROM work_metadata_overrides o, json_each(o.value) j
       WHERE o.field='series' AND json_valid(o.value) AND json_extract(j.value,'$.local')=1`,
    )
    .pluck()
    .all()
    .filter((id): id is string => typeof id === "string" && isLocalSeriesId(id));
}

// ---- Uploaded covers ----
const coverDir = () => join(mediaRoot, "covers");
const COVER_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const COVER_MIME: Record<string, string> = Object.fromEntries(Object.entries(COVER_TYPES).map(([mime, ext]) => [ext, mime]));
export const COVER_UPLOAD_LIMIT = 10 * 1024 * 1024;

/** Keeps an uploaded image under its content's hash; the address it is served at. */
export function keepUploadedCover(data: Buffer, mime: string): string {
  const ext = COVER_TYPES[mime];
  if (!ext) throw Object.assign(new Error("Choose a JPEG, PNG, WebP or GIF image."), { statusCode: 400 });
  if (!data.length) throw Object.assign(new Error("The image is empty."), { statusCode: 400 });
  const problem = mediaMountProblem();
  if (problem) throw Object.assign(new Error(problem), { statusCode: 503 });
  const name = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
  mkdirSync(coverDir(), { recursive: true });
  const path = join(coverDir(), name);
  if (!existsSync(path)) writeFileSync(path, data);
  return `/api/covers/${name}`;
}

/** The Edit page's answer for the administrator, built by library-works.ts (it builds works). */
export type MetadataReader = (userId: number, workId: string) => WorkMetadata | null;

export function registerWorkMetadataRoutes(app: FastifyInstance, read: MetadataReader) {
  const params = z.object({ workId: z.string().min(1).max(200) });
  const answer = (userId: number, workId: string) => {
    const metadata = read(userId, workId);
    if (!metadata) throw Object.assign(new Error("This book could not be found."), { statusCode: 404 });
    return metadata;
  };
  app.get("/api/works/:workId/metadata", async (req) => {
    requireAdmin(req);
    return answer(currentUserId(req), params.parse(req.params).workId);
  });
  /** `{ values?: { <field>: value }, revert?: [<field>] }`; an empty body changes nothing (an older client's). */
  app.patch("/api/works/:workId/metadata", async (req) => {
    requireAdmin(req);
    const userId = currentUserId(req);
    const { workId } = params.parse(req.params);
    const body = z
      .object({ values: z.record(z.string(), z.unknown()).optional(), revert: z.array(z.enum(WORK_FIELDS)).max(WORK_FIELDS.length).optional() })
      .parse(req.body ?? {});
    const current = answer(userId, workId);
    const unknown = Object.keys(body.values ?? {}).filter((field) => !(WORK_FIELDS as readonly string[]).includes(field));
    if (unknown.length) throw Object.assign(new Error(`Unknown field: ${unknown.join(", ")}.`), { statusCode: 400 });
    writeWorkEdits(workId, current.source, body.values ?? {}, body.revert ?? []);
    return answer(userId, workId);
  });
  /** `{ narrators: string[] }` edits a recording's narrators; `{ narrators: null }` reverts them. */
  app.patch("/api/recordings/:recordingId/metadata", async (req) => {
    requireAdmin(req);
    const userId = currentUserId(req);
    const { recordingId } = z.object({ recordingId: z.string().min(1).max(200) }).parse(req.params);
    const { narrators } = z.object({ narrators: names.nullable() }).parse(req.body ?? {});
    const workId = sqlite
      .prepare("SELECT e.work_id FROM recordings r JOIN audio_editions e ON e.id=r.edition_id WHERE r.id=?")
      .pluck()
      .get(recordingId) as string | undefined;
    const current = workId ? read(userId, workId) : null;
    const recording = current?.recordings.find((entry) => entry.recordingId === recordingId);
    if (!workId || !recording) throw Object.assign(new Error("This recording could not be found."), { statusCode: 404 });
    writeNarrators(recordingId, recording.source, narrators);
    return answer(userId, workId);
  });
  /** An uploaded cover (one image, multipart): kept on the media drive and set as the work's edited cover. */
  app.post("/api/works/:workId/cover", async (req) => {
    requireAdmin(req);
    const userId = currentUserId(req);
    const { workId } = params.parse(req.params);
    answer(userId, workId);
    const part = await req.file({ limits: { fileSize: COVER_UPLOAD_LIMIT, files: 1 } });
    if (!part) throw Object.assign(new Error("Choose an image."), { statusCode: 400 });
    const data = await part.toBuffer();
    if (part.file.truncated) throw Object.assign(new Error("The image is larger than 10 MB."), { statusCode: 413 });
    const cover = keepUploadedCover(data, part.mimetype);
    writeWorkEdits(workId, answer(userId, workId).source, { cover }, []);
    return answer(userId, workId);
  });
  app.get("/api/covers/:file", async (req, reply) => {
    const { file } = z.object({ file: z.string().regex(/^[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/) }).parse(req.params);
    const path = join(coverDir(), file);
    if (!existsSync(path)) return reply.code(404).send({ error: "This cover could not be found." });
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.type(COVER_MIME[file.split(".").pop()!]).send(createReadStream(path));
  });
}
