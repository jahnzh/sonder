/**
 * Every activity source, written out (ADR 0010). Sources do not register themselves on import, so a source that
 * is missing here is missing visibly. The order is the order of items that sort equal on the page; the loops are
 * listed in the order of `PAUSABLE_PROCESSES`.
 */
import { acquisitionSource } from "./acquisitions-activity.ts";
import { serverCopySource } from "./downloads-activity.ts";
import { seriesAcquisitionSource } from "./series-acquisition-activity.ts";
import { alignmentSource } from "./alignment-activity.ts";
import { ebookSetSource } from "./ebook-set-activity.ts";
import { backupSource } from "./backups-activity.ts";

export const ACTIVITY_SOURCES = [
  acquisitionSource,
  serverCopySource,
  seriesAcquisitionSource,
  alignmentSource,
  ebookSetSource,
  backupSource,
];
