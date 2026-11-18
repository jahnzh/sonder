// The shell's upload module (#605, spec #600 "Import from this device" and "Boundaries"): the one place an import
// from this device outlives the Get sheet that started it. It holds at most one upload: audio files sent in name
// order to `POST /api/import` with the book's `workId`, or one EPUB or PDF sent to `POST /api/ebooks/import?workId=`.
// A sheet watches the upload of its own book and kind while it is open: the end then closes it to the Book page, and a
// refusal stands in its row. With no sheet watching, the end is the app's toast. A reload stops the upload, as today
// (the request goes with the page). The shell configures how the library is read again and how a toast is shown.
import { useSyncExternalStore } from "react";

export type ImportKind = "audiobook" | "ebook";

/** Today's `accept` lists: the audio types of the Add audiobook dialog, the ebook types of the Ebook page. */
export const AUDIO_ACCEPT = ".mp3,.m4b,.m4a,.ogg,.opus,.flac,.wav,audio/*";
export const EBOOK_ACCEPT = ".epub,.pdf,application/epub+zip,application/pdf";

export type DeviceImport = {
  kind: ImportKind;
  workId: string;
  /** The book's title, for the toast. */
  title: string;
  /** `uploading` while the bytes go; `processing` at 100 % until the server answers; `failed` once it refused. */
  phase: "uploading" | "processing" | "failed";
  /** 0 to 1 of the bytes sent. */
  progress: number;
  /** The server's refusal, while `failed`. */
  error: string | null;
};

/** How one upload is sent: the progress of its bytes, then the server's answer or its refusal (a thrown Error). */
export type Send = (request: { url: string; form: FormData; onProgress: (fraction: number) => void }) => Promise<unknown>;

type Shell = {
  /** The library changed: the shell and the library-by-work store read it again. */
  refresh: () => Promise<void> | void;
  /** The app's toast. */
  notify: (text: string, error?: boolean) => void;
};

/** The sentences for an upload that ends without the server's own. */
export const AUDIO_NOT_IMPORTED = "Your audiobook could not be imported.";
export const EBOOK_NOT_IMPORTED = "This ebook could not be imported.";
export const INTERRUPTED = "The upload was interrupted. Please try again.";

/** The toast for an upload that ended with no sheet watching it. */
export function importedToast(kind: ImportKind, title: string) {
  return kind === "audiobook" ? `${title}: audio files imported.` : `${title}: ebook imported.`;
}

/** Today's order of chosen audio files: by name, numbers as numbers ("2" before "10"). */
export function inNameOrder<T extends { name: string }>(files: Iterable<T>): T[] {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** The browser's upload with its progress, as the Add audiobook dialog sends it today. */
export const xhrSend: Send = ({ url, form, onProgress }) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let data: { error?: unknown } | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(typeof data?.error === "string" && data.error ? data.error : ""));
    };
    xhr.onerror = () => reject(new Error(INTERRUPTED));
    xhr.send(form);
  });

type Watcher = { kind: ImportKind; workId: string; onDone: () => void };

export function createDeviceImports(send: Send = xhrSend) {
  let current: DeviceImport | null = null;
  let shell: Shell | null = null;
  const listeners = new Set<() => void>();
  const watchers = new Set<Watcher>();
  const set = (next: DeviceImport | null) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const watcherOf = (kind: ImportKind, workId: string) => [...watchers].find((watcher) => watcher.kind === kind && watcher.workId === workId) ?? null;

  /** An upload is on its way: a second one waits until it ends. */
  const busy = () => !!current && current.phase !== "failed";

  const start = (kind: ImportKind, workId: string, title: string, files: File[]): boolean => {
    if (busy() || !files.length) return false;
    const form = new FormData();
    let url: string;
    if (kind === "audiobook") {
      // The book before the files: the server refuses an unknown one before it writes any.
      form.set("workId", workId);
      for (const file of inNameOrder(files)) form.append("files", file);
      url = "/api/import";
    } else {
      form.append("file", files[0]);
      url = `/api/ebooks/import?workId=${encodeURIComponent(workId)}`;
    }
    const upload: DeviceImport = { kind, workId, title, phase: "uploading", progress: 0, error: null };
    set(upload);
    const onProgress = (fraction: number) => {
      if (!busy()) return;
      const progress = Math.min(1, Math.max(0, fraction));
      set({ ...upload, progress, phase: progress >= 1 ? "processing" : "uploading" });
    };
    void send({ url, form, onProgress }).then(
      async () => {
        set({ ...upload, phase: "processing", progress: 1 });
        try {
          await shell?.refresh();
        } catch {
          // The library is read again on its next change; the import itself is done.
        }
        set(null);
        const watcher = watcherOf(kind, workId);
        if (watcher) watcher.onDone();
        else shell?.notify(importedToast(kind, title));
      },
      (error: Error) => {
        const message = error?.message || (kind === "audiobook" ? AUDIO_NOT_IMPORTED : EBOOK_NOT_IMPORTED);
        if (watcherOf(kind, workId)) set({ ...upload, phase: "failed", error: message });
        else {
          set(null);
          shell?.notify(message, true);
        }
      },
    );
    return true;
  };

  return {
    get: () => current,
    busy,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    configure(next: Shell) {
      shell = next;
    },
    start,
    /** A sheet open for this book and kind: the end closes it (`onDone`), a refusal stands in its row. */
    watch(kind: ImportKind, workId: string, onDone: () => void) {
      const watcher = { kind, workId, onDone };
      watchers.add(watcher);
      return () => {
        watchers.delete(watcher);
        // A refusal shown in the row goes with the sheet.
        if (current?.phase === "failed" && current.kind === kind && current.workId === workId && !watcherOf(kind, workId)) set(null);
      };
    },
  };
}

export type DeviceImports = ReturnType<typeof createDeviceImports>;

/** The app's one upload module. */
export const deviceImports = createDeviceImports();

export function useDeviceImport(imports: DeviceImports = deviceImports) {
  return useSyncExternalStore(imports.subscribe, imports.get, imports.get);
}

/** What the import row of a sheet shows for its book and kind. */
export type ImportRow =
  /** The row opens the device's file chooser. */
  | { state: "ready" }
  /** Another upload is on its way: the row is off until it ends. */
  | { state: "waiting" }
  /** This book's upload: a File row with its status line and bar. */
  | { state: "running"; progress: number; phase: "uploading" | "processing" }
  /** This book's upload was refused: the refusal in the failed colour, and the row can be tapped again. */
  | { state: "failed"; error: string };

export function importRow(current: DeviceImport | null, kind: ImportKind, workId: string): ImportRow {
  if (!current) return { state: "ready" };
  const ours = current.kind === kind && current.workId === workId;
  if (current.phase === "failed") return ours ? { state: "failed", error: current.error || "" } : { state: "ready" };
  if (!ours) return { state: "waiting" };
  return { state: "running", progress: current.progress, phase: current.phase };
}
