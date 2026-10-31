import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCODE_MODEL = "nris/Qwen3.8-27B";

// JSONC is JSON with comments and trailing commas. Scan strings separately so URLs,
// escaped quotes and comment-like text in credentials are never modified.
export function parseJsonc(text) {
  let clean = "";
  let string = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (string) {
      clean += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
    } else if (char === '"') {
      string = true;
      clean += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
      clean += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("invalid JSONC");
      i = end + 1;
      clean += " ";
    } else {
      clean += char;
    }
  }
  let result = "";
  string = false;
  escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (string) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
    } else if (char === '"') {
      string = true;
      result += char;
    } else if (char === "," && /^[\s]*[}\]]/.test(clean.slice(i + 1))) {
      continue;
    } else {
      result += char;
    }
  }
  return JSON.parse(result.replace(/^\uFEFF/, ""));
}

export function readOpencodeConfig(configPath = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc")) {
  return parseJsonc(readFileSync(configPath, "utf8"));
}

export function configuredModel(config) {
  return config?.model === OPENCODE_MODEL && Boolean(config?.provider?.nris?.models?.["Qwen3.8-27B"]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "verify" || process.argv[3] !== OPENCODE_MODEL || !configuredModel(readOpencodeConfig())) {
      throw new Error("default model mismatch");
    }
  } catch {
    console.error("OpenCode default model is missing, invalid, or does not match the requested model.");
    process.exitCode = 1;
  }
}
