// One schema-constrained chat request to a local llama.cpp server (OpenAI-compatible, `response_format` with a JSON
// schema, which the server turns into a grammar). Only a loopback or private-network address is accepted: the
// prototype never calls a hosted model.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** `retries`: requests asked again, for a reply that was not JSON or a server error; `serverErrors`: those that were a server error. */
export type Timing = { ms: number; promptTokens: number; cachedTokens: number; outputTokens: number; promptMs: number; outputMs: number; retries: number; serverErrors: number };

const base = () => {
  const url = new URL(process.env.RECAP_LLM_URL ?? "http://127.0.0.1:8091");
  const host = url.hostname;
  if (!(host === "localhost" || host === "127.0.0.1" || host === "::1" || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)))
    throw new Error(`RECAP_LLM_URL must be a local address, not ${host}: this prototype makes no hosted or paid calls.`);
  return url.origin;
};

export async function ask<T>(request: { system: string; user: string; schema: object; maxTokens: number; temperature?: number; seed?: number }): Promise<{ value: T; timing: Timing; raw: string }> {
  const timing = noTiming();
  let last = "";
  // A reply cut off at the token limit is not valid JSON, and llama.cpp's grammar sampler now and then fails a
  // request with a 500 ("Unexpected empty grammar stack", seen with Qwen3.5 on build b12589): ask again with another
  // seed, up to three times in all.
  const attempts = [0, 1, 2];
  for (const attempt of attempts) {
    const started = performance.now();
    const response = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: "reply", strict: true, schema: request.schema } },
        temperature: request.temperature ?? 0.2,
        top_p: 0.9,
        seed: (request.seed ?? 7) + attempt,
        max_tokens: request.maxTokens,
        cache_prompt: true,
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      timing.ms += performance.now() - started;
      if (response.status < 500 || attempt === attempts.at(-1)) throw new Error(`The model server answered ${response.status}: ${text.slice(0, 400)}`);
      timing.retries++;
      timing.serverErrors++;
      last = text;
      continue;
    }
    const body = JSON.parse(text);
    const timings = body.timings ?? {};
    timing.ms += performance.now() - started;
    timing.promptTokens += timings.prompt_n ?? body.usage?.prompt_tokens ?? 0;
    timing.cachedTokens += timings.cache_n ?? 0;
    timing.outputTokens += timings.predicted_n ?? body.usage?.completion_tokens ?? 0;
    timing.promptMs += timings.prompt_ms ?? 0;
    timing.outputMs += timings.predicted_ms ?? 0;
    last = String(body.choices?.[0]?.message?.content ?? "");
    try {
      return { value: JSON.parse(last) as T, timing, raw: last };
    } catch {
      timing.retries++;
      // RECAP_DEBUG_DIR keeps the server's whole answer to a failed request, for reading afterwards.
      if (process.env.RECAP_DEBUG_DIR) writeFileSync(join(process.env.RECAP_DEBUG_DIR, `failed-${Date.now()}-${attempt}.json`), text);
    }
  }
  throw new Error(`The model did not return JSON in ${attempts.length} tries. Its last reply (${last.length} characters) starts: ${last.slice(0, 200)} … and ends: ${JSON.stringify(last.slice(-300))}`);
}

export const addTiming = (total: Timing, part: Timing) => {
  for (const key of Object.keys(total) as (keyof Timing)[]) total[key] += part[key];
  return total;
};
export function noTiming(): Timing {
  return { ms: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, promptMs: 0, outputMs: 0, retries: 0, serverErrors: 0 };
}
export const perSecond = (tokens: number, ms: number) => (ms > 0 ? Math.round((tokens / ms) * 1000) : 0);
