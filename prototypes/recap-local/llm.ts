// One request to a model, answered as JSON of a given schema. Two providers behind `ask`, chosen by RECAP_PROVIDER:
//
//   llama (default)  A local llama.cpp server (OpenAI-compatible; `response_format` with a JSON schema, which the
//                    server turns into a grammar). Only a loopback or private-network address is accepted.
//   claude-cli       A hosted Claude model through the Claude Code CLI signed in on this machine (`claude -p`), on
//                    the owner's subscription, for comparing a hosted model with the local ones. RECAP_MODEL names
//                    the model. The CLI runs in an empty folder with no tools, no MCP servers, no settings and the
//                    request's own system prompt, so the model sees the prompt and a few hundred tokens the CLI adds.
//                    Nothing constrains its output: the schema is written into the prompt and the reply is held
//                    against it by `conform`. One call per request, never asked again. A production server would
//                    call the API with a key instead; what each call would have cost there is worked out from the
//                    token counts the CLI reports.
//
// Every reply, from either provider, goes through `conform`.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conform } from "./lib.ts";

/**
 * `retries`: requests asked again, for a reply that was not JSON or a server error; `serverErrors`: those that were
 * a server error. `thinkingTokens` are part of `outputTokens`. `costUsd` is what the request would cost on the API
 * (0 for a local model). `schemaViolations`: places where the reply broke its schema and code put it right.
 */
export type Timing = {
  ms: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  promptMs: number;
  outputMs: number;
  retries: number;
  serverErrors: number;
  schemaViolations: number;
  costUsd: number;
};
export function noTiming(): Timing {
  return { ms: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, thinkingTokens: 0, promptMs: 0, outputMs: 0, retries: 0, serverErrors: 0, schemaViolations: 0, costUsd: 0 };
}
export const addTiming = (total: Timing, part: Timing) => {
  for (const key of Object.keys(total) as (keyof Timing)[]) total[key] += part[key] ?? 0;
  return total;
};
export const perSecond = (tokens: number, ms: number) => (ms > 0 ? Math.round((tokens / ms) * 1000) : 0);

/** The run cannot go on (a usage or rate limit, no sign-in): callers stop instead of going to the next request. */
export class StopRun extends Error {}
/** An error of a request that reached the model: what it used is kept, so that a failed call is still counted. */
const failed = (message: string, timing: Timing) => Object.assign(new Error(message), { timing });
export const timingOf = (error: unknown): Timing => (error as { timing?: Timing })?.timing ?? noTiming();

type Request = { system: string; user: string; schema: object; maxTokens: number; temperature?: number; seed?: number };
type Reply<T> = { value: T; timing: Timing; raw: string; violations: string[] };

/**
 * API prices in USD per million tokens (platform.claude.com, November 2026). Haiku 5.5's are for prompts up to
 * 100,000 tokens; a longer prompt costs five times as much for the whole request. No request here comes near that.
 */
export const PRICES: Record<string, { input: number; output: number; cliffTokens?: number; cliffFactor?: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cliffTokens: 100_000, cliffFactor: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};
/** What a request costs on the API without prompt caching: every prompt token at the input price. */
export function apiCost(model: string, promptTokens: number, outputTokens: number) {
  const price = PRICES[model];
  if (!price) return 0;
  const factor = price.cliffTokens && promptTokens > price.cliffTokens ? (price.cliffFactor ?? 1) : 1;
  return ((promptTokens * price.input + outputTokens * price.output) * factor) / 1e6;
}

export const provider = () => process.env.RECAP_PROVIDER ?? "llama";

export async function ask<T>(request: Request): Promise<Reply<T>> {
  return provider() === "claude-cli" ? askClaude<T>(request) : askLlama<T>(request);
}

/** The reply's text as a value of the schema, or why it is not one: it is not JSON, or not an object of that shape. */
function shaped<T>(schema: object, text: string): { value: T; violations: string[] } | { why: string } {
  let parsed: unknown;
  try {
    // A model without a grammar may wrap its JSON in a code fence.
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch (error) {
    return { why: `not JSON (${(error as Error).message.slice(0, 120)})` };
  }
  return (conform(schema, parsed) as { value: T; violations: string[] } | null) ?? { why: "JSON, but not an object of the schema's shape" };
}

// --- llama.cpp ------------------------------------------------------------------------------------------------

const base = () => {
  const url = new URL(process.env.RECAP_LLM_URL ?? "http://127.0.0.1:8091");
  const host = url.hostname;
  if (!(host === "localhost" || host === "127.0.0.1" || host === "::1" || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)))
    throw new Error(`RECAP_LLM_URL must be a local address, not ${host}.`);
  return url.origin;
};

async function askLlama<T>(request: Request): Promise<Reply<T>> {
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
    const reply = shaped<T>(request.schema, last);
    if (!("why" in reply)) {
      timing.schemaViolations += reply.violations.length;
      return { ...reply, timing, raw: last };
    }
    timing.retries++;
    // RECAP_DEBUG_DIR keeps the server's whole answer to a failed request, for reading afterwards.
    if (process.env.RECAP_DEBUG_DIR) writeFileSync(join(process.env.RECAP_DEBUG_DIR, `failed-${Date.now()}-${attempt}.json`), text);
  }
  throw new Error(`The model did not return JSON in ${attempts.length} tries. Its last reply (${last.length} characters) starts: ${last.slice(0, 200)} … and ends: ${JSON.stringify(last.slice(-300))}`);
}

// --- Claude through the Claude Code CLI -------------------------------------------------------------------------

let emptyFolder: string | undefined;
/** An empty folder to run the CLI in, so that it finds no project, no CLAUDE.md and no settings. Removed at exit. */
function emptyCwd() {
  if (!emptyFolder) {
    emptyFolder = mkdtempSync(join(tmpdir(), "recap-claude-cli-"));
    const folder = emptyFolder;
    process.on("exit", () => rmSync(folder, { recursive: true, force: true }));
  }
  return emptyFolder;
}

function runCli(args: string[], stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Only what the CLI needs to find itself and the owner's sign-in: none of the variables that would make it a
    // child of the session that started this script.
    const env = { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", USER: process.env.USER ?? "", LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb" };
    const child = spawn(process.env.RECAP_CLAUDE_BIN ?? "claude", args, { cwd: emptyCwd(), env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function askClaude<T>(request: Request): Promise<Reply<T>> {
  const model = process.env.RECAP_MODEL;
  if (!model || !PRICES[model]) throw new Error(`RECAP_MODEL must be one of ${Object.keys(PRICES).join(", ")} for the claude-cli provider.`);
  const timing = noTiming();
  const prompt = `${request.user}\n\nAnswer with one JSON object and nothing else: no code fence, no comment before or after it. It must match this JSON schema:\n${JSON.stringify(request.schema)}`;
  const started = performance.now();
  const ran = await runCli(
    ["-p", "--model", model, "--output-format", "json", "--system-prompt", request.system, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--effort", process.env.RECAP_EFFORT ?? "low"],
    prompt,
  );
  timing.ms = performance.now() - started;
  let body: Record<string, any>;
  try {
    body = JSON.parse(ran.stdout);
  } catch {
    const said = `${ran.stdout} ${ran.stderr}`.slice(0, 400);
    if (/limit|quota|log ?in|credit|unauthor/i.test(said)) throw new StopRun(`The Claude CLI stopped: ${said}`);
    throw new Error(`The Claude CLI did not answer in JSON (exit ${ran.code}): ${said}`);
  }
  const usage = body.usage ?? {};
  timing.promptTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  timing.cachedTokens = usage.cache_read_input_tokens ?? 0;
  timing.outputTokens = usage.output_tokens ?? 0;
  timing.thinkingTokens = usage.output_tokens_details?.thinking_tokens ?? 0;
  // The CLI reports the time to the first streamed token and the time inside the API: reading and writing, roughly.
  timing.promptMs = body.ttft_stream_ms ?? 0;
  timing.outputMs = Math.max(0, (body.duration_api_ms ?? 0) - (body.ttft_stream_ms ?? 0));
  timing.costUsd = apiCost(model, timing.promptTokens, timing.outputTokens);
  const text = String(body.result ?? "");
  if (body.is_error || body.subtype !== "success") {
    const said = `${body.subtype ?? ""} ${body.api_error_status ?? ""} ${text}`.slice(0, 400);
    if (body.api_error_status === 429 || body.api_error_status === 401 || /usage limit|rate limit|limit reached|quota|log ?in/i.test(said)) throw new StopRun(`The Claude CLI stopped: ${said}`);
    throw failed(`The Claude CLI reported an error: ${said}`, timing);
  }
  if (body.stop_reason && body.stop_reason !== "end_turn") throw failed(`The model stopped with "${body.stop_reason}": ${text.slice(0, 200)}`, timing);
  const reply = shaped<T>(request.schema, text);
  if ("why" in reply) {
    if (process.env.RECAP_DEBUG_DIR) writeFileSync(join(process.env.RECAP_DEBUG_DIR, `failed-${Date.now()}.json`), ran.stdout);
    throw failed(`The model's reply is ${reply.why}. It starts: ${text.slice(0, 200)}`, timing);
  }
  timing.schemaViolations = reply.violations.length;
  return { ...reply, timing, raw: text };
}
