// Data preparation for the live check; no browser or server writes.

/** First, middle and last sections with intervals, in the EPUB's reading order. */
export function sampleSentences(map, manifest) {
  const intervals = map.intervals || [];
  if (!intervals.length) throw new Error("The prepared map has no intervals.");
  const bySection = new Map();
  for (const interval of intervals) {
    if (!bySection.has(interval.section)) bySection.set(interval.section, []);
    bySection.get(interval.section).push(interval);
  }
  const sections = manifest.sections.filter((section) => bySection.has(section.index));
  const known = new Set(sections.map((section) => section.index));
  for (const section of bySection.keys())
    if (!known.has(section)) throw new Error(`Map interval names an unknown section: ${section}`);
  return [sections[0], sections[Math.floor(sections.length / 2)], sections.at(-1)].map((section) => {
    const candidates = bySection.get(section.index).flatMap((interval) => {
      if (interval.section !== section.index || !interval.trackId || interval.end - interval.start <= 2) return [];
      const text = section.paragraphs.find((paragraph) => paragraph.id === interval.paragraphId)?.text;
      return typeof text === "string" && text.length >= 80 && text.length < 300 ? [{ interval, text, section }] : [];
    });
    if (!candidates.length) throw new Error(`No sentence-sized test passage in mapped section ${section.index}.`);
    return candidates[Math.floor(candidates.length / 2)];
  });
}

/** Independent expectations for the page's pair and finished-map status. */
export function pageExpectations(work, book, ebookId, job) {
  const recording = work.recordings.find((item) => item.recordingId === work.chosenRecordingId) ?? work.recordings[0];
  const readable = work.ebooks.filter((item) => item.format === "epub" && item.available);
  const ebook = readable.find((item) => item.id === work.chosenEbookId) ?? readable[0];
  if (!recording || recording.recordingId !== book.recordingId || !ebook || ebook.id !== ebookId)
    throw new Error("The requested recording and ebook must be the work's chosen pair on the Reading sync page.");
  if (!['ready', 'partial'].includes(job.status) || job.outcome === 'unsynced' || job.outcome === 'language_not_supported' || !(job.coverage > 0))
    throw new Error("The pair does not have a finished usable reading sync map.");
  const figure = (value) => value >= 9.95 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  const size = ebook.size >= 1e9 ? `${figure(ebook.size / 1e9)} GB`
    : ebook.size >= 1e6 ? `${figure(ebook.size / 1e6)} MB`
    : `${Math.round(ebook.size / 1e3)} KB`;
  return {
    workId: book.workId,
    title: work.title,
    recording: recording.narrator?.trim() || "Unknown narrator",
    edition: [ebook.format.toUpperCase(), ebook.size > 0 ? size : null].filter(Boolean).join(" · "),
    status: job.status === "ready" || job.coverage > 0.95 ? "Ready" : "Partly ready",
    mapped: `${Math.min(100, Math.max(0, Math.round((Number.isFinite(job.coverage) ? job.coverage : 0) * 100)))}%`,
    unsyncedPassages: (job.unsyncedPassages || []).length,
  };
}
