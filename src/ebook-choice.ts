// The Ebook page's rules (#531, spec #526 "The Ebook page"): which edition of a work is the chosen one, and the
// lines its rows show. Pure: no window, no database, so the rules are tested with plain data. The Ebook page, the
// Ebook row of today's book dialog and Read (`ReaderShortcut`) all choose through `chosenEbook`, so Read opens the
// edition the page ticks.
//
// The server must not import this file: the production image copies only four files of `src/`.
import type { LibraryWork, WorkEbook } from "./types";
import { bytes } from "./size-format";
import { downloadLine, ebookCheckLine } from "./status-lines";

const DOT = " · ";

/** This device's choice of edition for a work, in the user's local storage (today's preference key). */
export const deviceEbookChoiceKey = (workId: string) => `reader-ebook:${workId}`;

/** An edition the reader can open: an EPUB whose file is on the server. */
export const readable = (ebook: Pick<WorkEbook, "format" | "available">) => ebook.format === "epub" && ebook.available;

/**
 * The chosen edition of a work: the shared default of ADR 0004 when there is one, then the one this user chose on
 * this device, then the only EPUB. Only an EPUB that is on the server is chosen. With several EPUBs and no choice,
 * the one added first is chosen, so Read never asks which one (the chooser of `ReaderShortcut` is gone).
 * Null when the work has no EPUB to read.
 */
export function chosenEbook(
  work: Pick<LibraryWork, "ebooks" | "chosenEbookId">,
  deviceChoice: string | null | undefined,
): WorkEbook | null {
  const epubs = work.ebooks.filter(readable);
  const pick = (id: string | null | undefined) => (id ? epubs.find((ebook) => ebook.id === id) ?? null : null);
  return pick(work.chosenEbookId) ?? pick(deviceChoice) ?? epubs[0] ?? null;
}

/**
 * What a tap on an EPUB row sets: the shared default for the administrator, when the edition can be one (only an
 * edition that matches the narration can: the server refuses any other), otherwise this device's choice.
 */
export function choiceTarget(admin: boolean, ebook: Pick<WorkEbook, "check">): "shared" | "device" {
  return admin && ebook.check?.status === "accepted" ? "shared" : "device";
}

/**
 * Whether a tap that sets this device's choice is overruled: a shared default other than the tapped edition wins
 * over this device's choice, so the tick stays where it is.
 */
export function overruledByShared(work: Pick<LibraryWork, "chosenEbookId" | "ebooks">, ebookId: string): boolean {
  const shared = work.chosenEbookId;
  return !!shared && shared !== ebookId && work.ebooks.some((ebook) => ebook.id === shared && readable(ebook));
}

/** An edition's first line: its format and size ("EPUB · 1.2 MB"); the format alone while its size is unknown. */
export function editionLabel(ebook: Pick<WorkEbook, "format" | "size">): string {
  const format = ebook.format.toUpperCase();
  return ebook.size > 0 ? `${format}${DOT}${bytes(ebook.size)}` : format;
}

/** A PDF's second line on the Ebook page: the reader does not open it. */
export const PDF_LINE = "Opens in another app";
/** An EPUB that is no member of the work's ebook set yet has no check to show. */
export const NOT_CHECKED_LINE = "Not checked";

/** An EPUB's second line: its check against the narration, from the status-line module. */
export function editionDetail(ebook: Pick<WorkEbook, "format" | "check">, hasRecording: boolean): string {
  if (ebook.format !== "epub") return PDF_LINE;
  if (ebook.check) {
    const line =
      ebook.check.status === "held"
        ? ebook.check.holdReason
          ? ebookCheckLine({ status: "held", holdReason: ebook.check.holdReason })
          : null
        : ebookCheckLine({ status: ebook.check.status });
    if (line) return line;
  }
  // No member of the set: without an audiobook there is nothing to check it against yet.
  return hasRecording ? NOT_CHECKED_LINE : ebookCheckLine({ status: "held", holdReason: "awaiting_audio" })!;
}

/**
 * The edition whose copies the page lists under Available from and whose file Export downloads: the chosen EPUB,
 * otherwise the first edition (a PDF-only work's PDF). Null without editions.
 */
export function shownEdition(work: Pick<LibraryWork, "ebooks" | "chosenEbookId">, deviceChoice: string | null | undefined) {
  return chosenEbook(work, deviceChoice) ?? work.ebooks[0] ?? null;
}

const ON_DEVICE = "This device";
const NOT_ON_SERVER = "Not on server";

/** The PDF-only line of the Book page's Ebook row (spec #526, "Files"). */
export const PDF_ONLY_LINE = "PDF · opens in another app";

/**
 * The Ebook row's one line (spec #526, "Files"): the chosen edition's format, size and where it is ("EPUB · 1.2 MB ·
 * On server", and "· This device" when this device keeps a copy too); a work whose editions are all PDFs reads
 * "PDF · opens in another app"; without any, "Not added". `deviceSize` is the size of this device's copy of the
 * chosen edition, or null when it has none.
 */
export function ebookRowLine(
  work: Pick<LibraryWork, "ebooks" | "chosenEbookId">,
  deviceChoice: string | null | undefined,
  deviceSize: number | null,
): string {
  if (!work.ebooks.length) return downloadLine({ status: null })!;
  const chosen = chosenEbook(work, deviceChoice);
  if (!chosen) {
    if (work.ebooks.every((ebook) => ebook.format === "pdf")) return PDF_ONLY_LINE;
    // EPUBs whose files are gone from the server.
    return `EPUB${DOT}${NOT_ON_SERVER}`;
  }
  const where = deviceSize != null ? `${DOT}${ON_DEVICE}` : "";
  return `${editionLabel(chosen)}${DOT}${downloadLine({ status: "ready", backend: "local" })}${where}`;
}
