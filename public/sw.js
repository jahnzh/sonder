/* Complete downloads and a bounded streaming cache are deliberately separate. */
const VERSION = /* VERSION */ "dev";
const SHELL = `sonder-shell-${VERSION}`;
const SEGMENTS = "sonder-stream-v1";
const PRECACHE = /* PRECACHE */ [];
const MAX_SEGMENTS = 24;
const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await (await caches.open(SHELL)).addAll(PRECACHE);
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("sonder-shell-") && key !== SHELL)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
function getRecord(store, key) {
  return new Promise((resolve) => {
    const req = indexedDB.open("sonder");
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(store)) {
        db.close();
        resolve(null);
        return;
      }
      const tx = db.transaction(store, "readonly");
      const get = tx.objectStore(store).get(key);
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    };
  });
}
function getChunks(trackId) {
  return new Promise((resolve) => {
    const req = indexedDB.open("sonder");
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("downloadChunks")) {
        db.close();
        resolve([]);
        return;
      }
      const tx = db.transaction("downloadChunks", "readonly");
      const items = tx
        .objectStore("downloadChunks")
        .index("trackId")
        .getAll(trackId);
      items.onsuccess = () => resolve(items.result || []);
      items.onerror = () => resolve([]);
      tx.oncomplete = () => db.close();
    };
  });
}
function rangeResponse(file, request) {
  const size = file.size;
  const header = request.headers.get("range");
  let start = 0,
    end = size - 1,
    status = 200;
  if (header) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1]
      ? match[2]
        ? Math.min(Number(match[2]), size - 1)
        : size - 1
      : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= size ||
      end < start ||
      start < 0
    )
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    status = 206;
  }
  const headers = {
    "Content-Type": file.type || "audio/mpeg",
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };
  if (status === 206)
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(
    request.method === "HEAD" ? null : file.slice(start, end + 1).stream(),
    { status, headers },
  );
}
async function localMedia(trackId, request) {
  const auth = await getRecord("preferences", "auth");
  if (auth?.value?.required && !auth.value.authenticated) return null;
  const item = await getRecord("downloads", trackId);
  if (!item) return null;
  if ((await getRecord("preferences", `device-fault:${item.recordingId}`))?.value) return null;
  try {
    let file;
    if (item.storage === "opfs") {
      const directory = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("sonder-audio");
      file = await (
        await directory.getFileHandle(`${trackId}.audio`)
      ).getFile();
    } else if (item.storage === "chunks") {
      const chunks = (await getChunks(trackId)).sort(
        (a, b) => a.offset - b.offset,
      );
      let offset = 0;
      for (const chunk of chunks) {
        if (chunk.offset !== offset) return null;
        offset += chunk.blob.size;
      }
      if (offset !== item.size) return null;
      file = new Blob(
        chunks.map((chunk) => chunk.blob),
        { type: item.mime || "audio/mpeg" },
      );
    } else file = item.blob;
    if (!file || file.size !== item.size) return null;
    return rangeResponse(
      new Blob([file], { type: item.mime || file.type || "audio/mpeg" }),
      request,
    );
  } catch {
    return null;
  }
}
async function media(request, event) {
  const id = decodeURIComponent(new URL(request.url).pathname.split("/").pop());
  // Downloads must come from the server, so a cached fragment cannot masquerade as a whole file.
  if (request.headers.has("X-Sonder-Download")) return fetch(request);
  const choice=new URL(request.url).searchParams.get("source");
  if(choice && choice!=="auto")return fetch(request);
  const local = await localMedia(id, request);
  if (local) {
    reportSource(event, id, "device");
    return local;
  }
  const auth = await getRecord("preferences", "auth");
  if (auth?.value?.required && !auth.value.authenticated) return fetch(request);
  const key = new URL(request.url);
  key.searchParams.set("sonder-range", request.headers.get("range") || "full");
  const cache = await caches.open(SEGMENTS);
  const cached = await cache.match(key.href);
  try {
    const response = await fetch(request);
    if (response.ok)
      reportSource(event, id, response.headers.get("X-Sonder-Media-Source"));
    if (response.ok && request.method === "GET") {
      const length = Number(response.headers.get("content-length"));
      if (length > 0 && length <= MAX_SEGMENT_BYTES) {
        const copy = response.clone();
        const headers = new Headers(copy.headers);
        headers.set("X-Sonder-Status", String(response.status));
        event.waitUntil(
          (async () => {
            const blob = await copy.blob();
            if (blob.size === length) {
              await cache.put(
                key.href,
                new Response(blob, { status: 200, headers }),
              );
              const keys = await cache.keys();
              while (keys.length > MAX_SEGMENTS)
                await cache.delete(keys.shift());
            }
          })().catch(() => {}),
        );
      }
    }
    return response;
  } catch (error) {
    if (cached) {
      reportSource(event, id, "device");
      const headers = new Headers(cached.headers);
      const status = Number(headers.get("X-Sonder-Status")) || 200;
      headers.delete("X-Sonder-Status");
      return new Response(cached.body, { status, headers });
    }
    throw error;
  }
}
function reportSource(event, trackId, source) {
  if (
    !event.clientId ||
    !["device", "server", "torbox", "remote"].includes(source)
  )
    return;
  event.waitUntil(
    self.clients
      .get(event.clientId)
      .then((client) =>
        client?.postMessage({ type: "sonder:media-source", trackId, source }),
      ),
  );
}
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    url.origin !== location.origin ||
    !["GET", "HEAD"].includes(request.method)
  )
    return;
  if (/^\/api\/media\/[^/]+$/.test(url.pathname)) {
    event.respondWith(media(request, event));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/audio/"))
    return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/index.html")));
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});
self.addEventListener("message", (event) => {
  if (event.data === "clear-stream-cache")
    event.waitUntil(caches.delete(SEGMENTS));
});
