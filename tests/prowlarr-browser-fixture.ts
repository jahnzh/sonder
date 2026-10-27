// Test-only Prowlarr transport. Never bundled into the production server.
export const prowlarrFixtureUrl = "http://prowlarr.fixture.test:9696";
export function installProwlarrFixture() {
  const original = globalThis.fetch;
  const hash = "1".repeat(40);
  const item = (title: string, indexer: string, extra: object) => ({
    guid: `https://${indexer.toLowerCase().replace(/\W/g, "")}.test/${encodeURIComponent(title)}`,
    indexerId: indexer.length,
    indexer,
    title,
    publishDate: "2026-09-01T00:00:00Z",
    categories: [{ id: 3030, name: "Audio/Audiobook" }],
    protocol: "torrent",
    downloadUrl: `${prowlarrFixtureUrl}/1/download?apikey=fixture-download-key&link=a`,
    ...extra,
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== prowlarrFixtureUrl) return original(input, init);
    if (new Headers(init?.headers).get("X-Api-Key") !== "fixture-prowlarr-key")
      return new Response("", { status: 401 });
    if (url.pathname === "/api/v1/system/status")
      return Response.json({ version: "fixture" });
    if (url.pathname === "/api/v1/indexer")
      return Response.json([{ enable: true, protocol: "torrent" }]);
    if (url.pathname === "/api/v1/search") {
      const query = url.searchParams.get("query")?.toLowerCase() || "";
      if (query.includes("broken")) return new Response("", { status: 500 });
      if (!query.includes("wonderland")) return Response.json([]);
      return Response.json([
        item("Alice’s Adventures in Wonderland", "Fixture Tracker", {
          size: 419430400,
          seeders: 25,
          infoHash: hash,
        }),
        item("Alice's Adventures in Wonderland (Unabridged)", "Second Tracker", {
          size: 419430400,
          seeders: 40,
          infoHash: hash.toUpperCase(),
        }),
        item("Lewis Carroll - Alice in Wonderland [M4B] 64kbps", "Fixture Tracker", {
          size: 268435456,
          seeders: 12,
        }),
      ]);
    }
    if (url.pathname === "/1/download")
      return new Response(null, {
        status: 301,
        headers: { Location: `magnet:?xt=urn:btih:${"2".repeat(40)}` },
      });
    return new Response("", { status: 404 });
  };
}
