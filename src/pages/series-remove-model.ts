// The Remove series dialog's model (#566, spec #560 "Remove series"; board SeriesRemove.dc.html): the title, the
// note, the administrator's switch, which works of `GET /api/series/<id>/removal` are offered and chosen, each one's
// line, the button and the body of `DELETE /api/series/<id>`, as pure functions of the preview, the role, the switch
// and what the user ticked. No React, no `window`, no fetch. The server imports nothing from here.

/** One work of `GET /api/series/<id>/removal` (server/series-removal.ts, `SeriesRemovalWork`). */
export type SeriesRemovalWork = {
  bookId: string;
  title: string;
  workId: string;
  /** Added with this series (glossary: Added with a series): only these are offered. */
  introduced: boolean;
  /** Chosen when the list opens: not when it is also in another saved series. */
  selectedByDefault: boolean;
  otherSeries: { id: string; name: string }[];
  activeDownloads: { id: string; title: string; status: string }[];
  audioEditions: { editionId: string; releaseTitle: string | null; wouldDelete: boolean; retainReason: string | null }[];
};
export type SeriesRemovalPreview = { id: string; name: string; works: SeriesRemovalWork[] };

/** The switch's name. */
export const REMOVE_BOOKS_LABEL = "Remove the books it added";
/** The note with the switch off, or for someone who is not the administrator. */
export const KEEP_NOTE = "Its books stay in your library, with their files and your places.";
/** The note with the switch on. */
export const REMOVE_NOTE = "The books chosen below leave your library and their files are deleted from the server. The other books stay, with your places.";
/** The caption of the books offered (board SeriesRemove.dc.html; glossary: Added with a series). */
export const OFFERED_CAPTION = "Added with this series";
/** The app's toast once the series is removed: the page is gone. */
export const REMOVED_TOAST = "Series removed";

export type SeriesRemoveChoice = { bookId: string; title: string; detail: string; chosen: boolean };

export type SeriesRemoveModel = {
  /** "Remove The Culture?" */
  title: string;
  note: string;
  /** The administrator's switch, while the series added books; null for anyone else. */
  switch: { label: string; on: boolean } | null;
  /** "Added with this series · 2", while the switch is on. */
  caption: string | null;
  /** The works the series added, while the switch is on. */
  choices: SeriesRemoveChoice[];
  button: string;
  /** `DELETE /api/series/<id>`: `bookIds` only with the switch on and books chosen. */
  body: { bookIds: string[] } | Record<string, never>;
};

/** What the user ticked or unticked, by AudiobookDB book id; the rest stand as `selectedByDefault`. */
export type SeriesRemoveManual = Readonly<Record<string, boolean>>;

/** A work's one line: why it is not chosen, else what happens to its files. */
export function removalLine(work: SeriesRemovalWork): string {
  if (work.otherSeries.length) return `Also in ${work.otherSeries.map((series) => series.name).join(", ")}`;
  if (work.activeDownloads.length) return "Its download stops";
  if (work.audioEditions.length) {
    return work.audioEditions.every((edition) => edition.wouldDelete)
      ? "Its audiobook is deleted from the server"
      : "Its audiobook stays: another listener has it";
  }
  return "Leaves your library";
}

export function removeButtonLabel(count: number): string {
  if (count <= 0) return "Remove series";
  return `Remove series and ${count} ${count === 1 ? "book" : "books"}`;
}

export function seriesRemoveModel(input: {
  /** The series' name as the page shows it, until the preview names it. */
  name: string;
  /** The administrator's preview; null while it is read, when it failed, or for anyone else. */
  preview: SeriesRemovalPreview | null;
  admin: boolean;
  on: boolean;
  manual: SeriesRemoveManual;
}): SeriesRemoveModel {
  const name = input.preview?.name || input.name;
  const offered = input.admin && input.preview ? input.preview.works.filter((work) => work.introduced) : [];
  const hasSwitch = offered.length > 0;
  const on = hasSwitch && input.on;
  const choices = on
    ? offered.map((work) => ({
        bookId: work.bookId,
        title: work.title,
        detail: removalLine(work),
        chosen: input.manual[work.bookId] ?? work.selectedByDefault,
      }))
    : [];
  const bookIds = choices.filter((choice) => choice.chosen).map((choice) => choice.bookId);
  return {
    title: `Remove ${name}?`,
    note: on ? REMOVE_NOTE : KEEP_NOTE,
    switch: hasSwitch ? { label: REMOVE_BOOKS_LABEL, on } : null,
    caption: on ? `${OFFERED_CAPTION} · ${choices.length}` : null,
    choices,
    button: removeButtonLabel(bookIds.length),
    body: bookIds.length ? { bookIds } : {},
  };
}
