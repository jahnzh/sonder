// APIRequestContext bypasses browser routes. Callers authenticate explicitly,
// audit every direct request, and install this guard before creating pages.
export async function protectBrowserMutations(context, baseURL, report) {
  const origin = new URL(baseURL).origin;
  const classify = (method, url) => {
    const path = url.pathname;
    if (url.origin !== origin) return null;
    if (method === 'POST' && path === '/api/progress') return 'progress';
    if (method === 'PUT' && /^\/api\/reader\/[^/]+\/progress$/.test(path)) return 'reader';
    if (method === 'POST' && /^\/api\/reader\/[^/]+\/bookmarks$/.test(path)) return 'bookmark';
    if (method === 'DELETE' && /^\/api\/reader\/[^/]+\/bookmarks\/[^/]+$/.test(path)) return 'delete';
    if (method === 'PUT' && path === '/api/appearance') return 'appearance';
    return null;
  };
  const answer = (method, rawURL, body, beacon = false) => {
    const url = new URL(rawURL, baseURL), kind = classify(method, url);
    if (!kind) {
      report.errors.push(`Blocked unexpected browser mutation: ${method} ${url.origin}${url.pathname}`);
      return {status:403, json:{error:'Unexpected browser mutation blocked by verification'}};
    }
    if (beacon) { report.protectedWrites++; return {status:200, json:{ok:true}}; }
    try {
      const data = kind === 'delete' ? null : JSON.parse(body);
      if (kind !== 'delete' && (!data || typeof data !== 'object' || Array.isArray(data))) throw Error('Expected a JSON object');
      let json;
      if (kind === 'progress') json = {progress:data};
      else if (kind === 'reader') {
        const {baseRevision, resolve, ...checkpoint} = data;
        json = {checkpoint:{...checkpoint, origin:checkpoint.origin || 'reading', revision:(baseRevision || 0) + 1, updatedAt:Date.now()}};
      } else if (kind === 'delete') json = {ok:true};
      else json = data;
      report.protectedWrites++;
      return {status:200, json};
    } catch (error) {
      report.errors.push(`Blocked invalid ${method} ${url.pathname}: ${error.message}`);
      return {status:400, json:{error:'Invalid verification mutation'}};
    }
  };
  // Chromium can bypass Playwright routing for unload beacons and keepalive
  // fetches. Suppress them in every frame before application code runs.
  await context.exposeBinding('__verificationSuppressed', (_source, method, url, body, beacon) => answer(method, url, body, beacon));
  await context.addInitScript((origin) => {
    const queue = (method, url) => {
      try {
        const key = '__verification_suppressed_beacons';
        const events = JSON.parse(localStorage.getItem(key) || '[]');
        events.push({method, url});
        localStorage.setItem(key, JSON.stringify(events));
      } catch { void window.__verificationSuppressed(method, url, null, true); }
    };
    navigator.sendBeacon = (url) => {
      queue('POST', new URL(url, location.href).href);
      return true;
    };
    const nativeFetch = window.fetch;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.keepalive && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const url = new URL(request.url), path = url.pathname, method = request.method;
        const expected = url.origin === origin && (
          (method === 'POST' && (path === '/api/progress' || /^\/api\/reader\/[^/]+\/bookmarks$/.test(path))) ||
          (method === 'PUT' && (path === '/api/appearance' || /^\/api\/reader\/[^/]+\/progress$/.test(path))) ||
          (method === 'DELETE' && /^\/api\/reader\/[^/]+\/bookmarks\/[^/]+$/.test(path))
        );
        if (!expected) queue(method, url.href);
        const result = await window.__verificationSuppressed(request.method, request.url, await request.text(), false);
        return new Response(JSON.stringify(result.json), {status:result.status, headers:{'Content-Type':'application/json'}});
      }
      return nativeFetch(input, init);
    };
  }, origin);
  await context.route('**/*', async route => {
    const request = route.request(), method = request.method();
    if (method === 'GET' && request.url() === new URL('/__verification_safety_monitor__', baseURL).href) return route.fulfill({status:200, contentType:'text/html', body:'<!doctype html><title>Verification monitor</title>'});
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
    const result = answer(method, request.url(), request.postData());
    await route.fulfill(result);
  });
  // Read the synchronous same-origin beacon ledger after pages unload and before
  // closing the context. Cross-origin/inaccessible storage and expected keepalive
  // fetches can still lose telemetry during destruction, although they are blocked.
  context.__verificationDrain = async () => {
    const monitor = await context.newPage();
    await monitor.goto(new URL('/__verification_safety_monitor__', baseURL).href);
    for (const page of context.pages()) {
      if (page === monitor) continue;
      page.on('dialog', dialog => void dialog.accept());
      const closed = page.waitForEvent('close', {timeout:5000});
      await page.close({runBeforeUnload:true});
      await closed;
    }
    const events = await monitor.evaluate(() => JSON.parse(localStorage.getItem('__verification_suppressed_beacons') || '[]'));
    for (const event of events) answer(event.method, event.url, null, true);
  };
}

// Never unroute before closing: pending page/unload writes must remain guarded.
export async function closeProtectedBrowser(context, browser, report) {
  try { if (context.__verificationDrain) await context.__verificationDrain(); } catch (error) { report.errors.push(`Beacon audit: ${error.message}`); }
  try { await context.close(); } catch (error) { report.errors.push(`Context close: ${error.message}`); }
  try { await browser.close(); } catch (error) { report.errors.push(`Browser close: ${error.message}`); }
  if (report.errors.length) { report.ok = false; process.exitCode = 1; }
}
