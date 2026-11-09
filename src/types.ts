export type Track = {
  serverAvailable?: boolean;
  deliverySource?: "server" | "torbox" | "remote";
  chapters?: { title: string; start: number; end?: number }[];
  id: string;
  recordingId: string;
  title: string;
  index: number;
  duration: number;
  source: string;
  sourceType: "local" | "remote" | "torbox";
};
export type Progress = {
  recordingId: string;
  trackId: string;
  position: number;
  duration: number;
  updatedAt: number;
};
export type Book = {
  faults?: Partial<Record<"recording"|"server"|"original",MediaFault>>;
  language?: string | null;
  releaseTitle?: string | null;
  hardcover?: {
    id: number;
    slug: string | null;
    series: { id?: number; name: string; position: number | null }[];
    statusId: number | null;
    pending: boolean;
    progressFraction: number | null;
    progressPending: boolean;
    syncError: string | null;
    listIds: number[];
  };
  id: string;
  workId: string;
  editionId: string;
  recordingId: string;
  title: string;
  author: string;
  narrator: string;
  description: string;
  cover: string;
  genre: string;
  duration: number;
  rating: number;
  year: number;
  tracks: Track[];
  inLibrary: boolean;
  status: "unread" | "listening" | "finished";
  addedAt: number;
  progress?: Progress;
  serverStored: boolean;
  sourceLabel: string;
  mediaState?: {
    state: "missing" | "queued" | "failed" | "available";
    holdReason?: "unreleased" | "empty_search" | null;
    acquisitionId?: string | null;
  } | null;
};
export type MediaFault={reason:"wrong-language"|"wrong-book"|"bad-audio"|"incomplete"|"other";note:string;updatedAt:number};
export type PlaybackSourceChoice="auto"|"device"|"server"|"original";
export type RecordingSources={recordingId:string;faults:NonNullable<Book['faults']>;managedCopies:number;serverFiles:number;originalFiles:number;tracks:{id:string;server:boolean;original:boolean}[]};
export type Download = {
  recordingId: string;
  trackId: string;
  name: string;
  size: number;
  storage: "opfs" | "idb" | "chunks";
  completedAt: number;
  mime?: string;
  blob?: Blob;
};
export type DownloadPart = {
  trackId: string;
  recordingId: string;
  loaded: number;
  total: number;
  mime: string;
  version: string | null;
};
export type Settings = {
  torboxConfigured: boolean;
  hardcoverConfigured: boolean;
  abbUrl: string;
  name: string;
  authenticated?: boolean;
  libgenUrl: string;
  localConfigured: boolean;
  storageLabel: string;
  prowlarrUrl?: string;
  prowlarrConfigured?: boolean;
};

export type Acquisition = {
  workId?: string | null;
  language?: string | null;
  narrator?: string | null;
  id: string;
  hash: string;
  backend: "local" | "torbox" | "copy";
  title: string;
  author: string;
  cover: string;
  status:
    | "checking"
    | "preparing"
    | "downloading"
    | "paused"
    | "ready"
    | "error";
  progress: number;
  error: string | null;
  bookId: string | null;
  createdAt: number;
  updatedAt: number;
};
export type AudiobookRelease = {
  id: string;
  title: string;
  author: string;
  cover?: string;
  url: string;
  language: string | null;
  narrator: string | null;
  format: string | null;
  bitrate: string | null;
  size: string | null;
  posted: string | null;
  uploader: string | null;
  description: string;
  // Absent on AudioBookBay releases from older servers.
  source?: "abb" | "prowlarr";
  indexer?: string | null;
  indexers?: string[];
  seeders?: number | null;
  leechers?: number | null;
  sizeBytes?: number | null;
  infoHash?: string | null;
  cached?: boolean;
};
export type ReleaseSourceStatus = {
  source: "abb" | "prowlarr";
  label: string;
  error?: string;
};
export type EbookResult = {
  md5: string;
  source: "libgen";
  title: string;
  authors: string[];
  extension: "epub" | "pdf";
  language: string | null;
  size: string | null;
  year: string | null;
  coverUrl: string | null;
  url: string;
};
export type SavedEbook = {
  id: string;
  workId: string;
  title: string;
  author: string;
  format: string;
  size: number;
  available: boolean;
};

export type AcquisitionStatus =
  | "pending"
  | "searching"
  | "done"
  | "failed"
  | "skipped";

export type SeriesWorkAcquisition = {
  kind: "audio" | "ebook";
  status: AcquisitionStatus;
  error?: string | null;
  skipReason?:
    | "unreleased"
    | "has_audio"
    | "has_ebook"
    | "no_permission"
    | null;
};

export type HardcoverState = {
  configured: boolean;
  mode: "off" | "import" | "two-way";
  syncLists: boolean;
  accountId: number | null;
  username: string | null;
  lastSync: number;
  lastError: string | null;
  listWarning: string | null;
  syncing: boolean;
  pending: number;
  linked: number;
  lists: { id: number; name: string; count: number; slug: string | null }[];
  shelves: { id: number; name: string }[];
};
export type TorrentHealth = {
  status: "ok" | "offline" | "unreachable" | "auth" | "error" | "unconfigured";
  // RPC answered with a valid session.
  session: boolean;
  // Outcome of Transmission's port test, which needs working DNS and egress through the VPN.
  network: "ok" | "port-closed" | "failed" | "unknown";
  version: string | null;
  message: string;
  checkedAt: number;
};

// Activity page (#357): one row per unit of background work, grouped under the background process that produces it.
export type ActivityKind = "acquisition" | "server-copy" | "series-acquisition" | "alignment" | "hardcover";
export type ActivityState = "running" | "queued" | "paused" | "failed" | "done";
export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  processId: string;
  title: string;
  detail: string | null;
  /** Whose item it is when the page is read by the administrator (one row per user for Hardcover). */
  user: string | null;
  state: ActivityState;
  /** 0 to 1, or null when the kind has no measurable progress. */
  progress: number | null;
  host: string | null;
  startedAt: number | null;
  updatedAt: number;
  error: string | null;
  /** A failed item that cannot succeed on retry (offered Discard in a later change, not Retry). */
  permanent: boolean;
  stuck: { reason: string } | null;
  /** The background process this item cannot move without, while that process is down. */
  blockedBy: string | null;
};
export type ActivityHealth = "ok" | "degraded" | "down" | "unknown";
export type ActivityProcess = {
  id: string;
  label: string;
  type: "loop" | "service";
  health: ActivityHealth;
  reason: string | null;
  /** When the current health began, if known. */
  since: number | null;
  /** True for a process the app does not track yet (imports, backups). */
  notTracked: boolean;
  counts: { running: number; queued: number; failed: number; stuck: number };
};
export type ActivityResponse = {
  checkedAt: number;
  stuckMultiplier: number;
  processes: ActivityProcess[];
  items: ActivityItem[];
  /** Number of failed, stuck or blocked items plus down processes: drives the indicator on Settings. */
  attention: number;
};
