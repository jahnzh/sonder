export async function installAlignmentFixture() {
  // Alignment runs only on the CTC pool (#279); this fixture is its WSL host. The server ignores ALIGNMENT_WORKER_URL.
  delete process.env.ALIGNMENT_WORKER_URL;
  process.env.ALIGNMENT_WORKER_TOKEN = "browser-fixture-token";
  process.env.ALIGNMENT_POOL_ENABLED = "1";
  const temp = process.env.MEDIA_ROOT!;
  const { CTC_ENGINE, installCtcTestPool, withCtcPoolFetch } = await import("./ctc-test-pool.ts");
  installCtcTestPool(temp, "http://alignment-browser.test");
  const original = globalThis.fetch;
  // Ebook text that carries a `pool-fails-once-<token>` word fails the first worker request that sends it, so
  // its job ends in the error state and a Resume runs it again (#324). Each test uses its own token.
  const failedOnce = new Set<string>();
  globalThis.fetch = withCtcPoolFetch(temp, async (input, init) => {
    if (!String(input).startsWith("http://alignment-browser.test/")) return original(input, init);
    const body = JSON.parse(String(init?.body));
    // Speech samples: a narration that starts at 5 s and reads one sentence every 8 s.
    if (String(input).endsWith("/anchor") || String(input).endsWith("/anchor-batch")) {
      if (String(input).endsWith("/anchor-batch")) {
        return Response.json({
          engine: CTC_ENGINE,
          outcome: "mapped",
          results: (body.windows as { start: number; duration: number }[]).map((window) => {
            const index = Math.max(0, Math.ceil((window.start - 5) / 8));
            if (index >= body.fragments.length || 5 + index * 8 > window.start + window.duration - 3)
              return { match: null, start: window.start, text: "", engine: CTC_ENGINE, outcome: "unsynced" };
            return {
              match: { index, score: 0.9, text: body.fragments[index] },
              start: 5 + index * 8,
              text: body.fragments[index],
              engine: CTC_ENGINE,
              outcome: "mapped",
            };
          }),
        });
      }
      const index = Math.max(0, Math.ceil((body.start - 5) / 8));
      if (index >= body.fragments.length || 5 + index * 8 > body.start + body.duration - 3)
        return Response.json({
          engine: CTC_ENGINE,
          outcome: "unsynced",
          match: null,
          start: body.start,
          text: "",
        });
      return Response.json({
        engine: CTC_ENGINE,
        outcome: "mapped",
        match: { index, score: 0.9, text: body.fragments[index] },
        start: 5 + index * 8,
        text: body.fragments[index],
      });
    }
    const token = JSON.stringify(body.fragments ?? []).match(/pool-fails-once-[\w-]+/)?.[0];
    if (token && !failedOnce.has(token)) {
      failedOnce.add(token);
      return Response.json({ error: "Browser fixture: this alignment request fails once." }, { status: 500 });
    }
    // The page-turn fixture's chapters (#509) are narrated at reading pace: each sentence takes time by its length.
    const { PACED_MARKER, PACED_CHARACTERS_PER_SECOND } = await import("./page-turn-fixture.ts");
    if ((body.fragments as string[]).some((text) => text.includes(PACED_MARKER))) {
      let cursor = body.start;
      return Response.json({
        engine: CTC_ENGINE,
        outcome: "mapped",
        elapsedSeconds: 0.1,
        intervals: (body.fragments as string[]).map((text, index) => {
          const start = cursor;
          cursor += Math.max(1, text.length / PACED_CHARACTERS_PER_SECOND);
          return { index, start, end: cursor };
        }),
      });
    }
    return Response.json({
      engine: CTC_ENGINE,
      outcome: "mapped",
      elapsedSeconds: 0.1,
      intervals: body.fragments.map((_: string, index: number) => ({
        index,
        start: body.start + index * 2,
        end: body.start + (index + 1) * 2,
      })),
    });
  });
}
