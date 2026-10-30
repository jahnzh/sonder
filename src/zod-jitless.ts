import { z } from "zod";
// Zod otherwise probes `new Function("")` and compiles parsers with it. The app's Content-Security-Policy has no
// 'unsafe-eval' (#76), so the probe is reported as a violation on every load. This must run before any schema is built.
z.config({ jitless: true });
