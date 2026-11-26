import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_PATHS, blocksMamUnlisted } from "../scripts/hooks/block-mam-unlisted.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "hooks", "block-mam-unlisted.mjs");

test("a page or function outside MAM's API list is blocked (rule 1.7)", () => {
  for (const command of [
    "curl -s https://www.myanonamouse.net/tor/browse.php",
    "curl https://www.myanonamouse.net/",
    "curl https://www.myanonamouse.net",
    "wget 'https://www.myanonamouse.net/t/12345'",
    "curl -b \"mam_id=$(cat ~/.config/sonder/mam-session)\" https://www.myanonamouse.net/jsonLoad.php https://www.myanonamouse.net/u/1",
    "curl https://www.myanonamouse.net/json/bonusBuy.php?spendtype=upload",
    "curl https://www.myanonamouse.net/takelogin.php -d user=x",
    "node -e \"fetch('https://www.myanonamouse.net/millionaires/donate.php')\"",
    "curl www.myanonamouse.net/tor/viewRequests.php",
    "curl https://www.myanonamouse.net/api/../tor/browse.php",
    "curl https://www.myanonamouse.net/api/%2e%2e/tor/browse.php",
    "curl https://WWW.MYANONAMOUSE.NET/index.php",
    "ls\ncurl https://cdn.myanonamouse.net/x.png",
  ]) assert.equal(blocksMamUnlisted(command), true, command);
});

test("the listed functions and the API documentation are allowed", () => {
  for (const command of [
    "curl -s -b \"mam_id=$id\" 'https://www.myanonamouse.net/tor/js/loadSearchJSONbasic.php?tor[text]=dune'",
    "curl -o x.torrent https://www.myanonamouse.net/tor/download.php/abcdef?tid=42",
    "curl https://www.myanonamouse.net/tor/download.php?tid=42",
    "curl https://t.myanonamouse.net/json/dynamicSeedbox.php",
    "curl https://t.myanonamouse.net/json/jsonIp.php",
    "curl https://www.myanonamouse.net/jsonLoad.php",
    "curl https://www.myanonamouse.net/api/list.php",
    "curl https://www.myanonamouse.net/api/endpoint.php/3/json/jsonLoad.php",
  ]) assert.equal(blocksMamUnlisted(command), false, command);
});

test("a mention of the site with no address is not blocked", () => {
  for (const command of [
    "grep -rn myanonamouse.net server/",
    "git commit -m 'MyAnonamouse: keep to the myanonamouse.net API list'",
    "echo see MyAnonamouse rule 1.7",
    "ls",
    "",
  ]) assert.equal(blocksMamUnlisted(command), false, command);
});

test("every MAM_ENDPOINTS address in server/sources/myanonamouse.ts is allowed by the hook", () => {
  // The server's allow-list is read as text: importing it would open the database.
  const source = readFileSync(join(repoRoot, "server", "sources", "myanonamouse.ts"), "utf8");
  const block = source.slice(source.indexOf("export const MAM_ENDPOINTS"), source.indexOf("} as const;"));
  const urls = [...block.matchAll(/url: "(https:\/\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(urls.length >= 4, `MAM_ENDPOINTS urls: ${urls.join(", ")}`);
  for (const url of urls) {
    assert.equal(blocksMamUnlisted(`curl ${url}`), false, url);
    assert.ok(ALLOWED_PATHS.includes(new URL(url).pathname.replace(/\/$/, "")), url);
  }
});

test("the hook exits 2 naming rule 1.7 and the allowed endpoints, and 0 otherwise or on bad input", () => {
  const run = (input) => spawnSync(process.execPath, [script], { input, encoding: "utf8" });
  const blocked = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "curl https://www.myanonamouse.net/tor/browse.php" } }));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /MAM rule 1\.7/);
  assert.match(blocked.stderr, /Not on the list: https:\/\/www\.myanonamouse\.net\/tor\/browse\.php/);
  for (const path of ALLOWED_PATHS) assert.ok(blocked.stderr.includes(path), path);
  assert.match(blocked.stderr, /\/api\//);
  assert.equal(run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "curl https://www.myanonamouse.net/api/list.php" } })).status, 0);
  assert.equal(run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "grep myanonamouse.net -r ." } })).status, 0);
  assert.equal(run("not json").status, 0);
  assert.equal(run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } })).status, 0);
});

test(".claude/settings.json runs the hook on Bash beside block-pattern-kill.mjs", () => {
  const settings = JSON.parse(readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"));
  const bash = settings.hooks.PreToolUse.find((entry) => entry.matcher === "Bash");
  const commands = bash.hooks.map((hook) => hook.command);
  assert.ok(commands.some((command) => command.includes("scripts/hooks/block-pattern-kill.mjs")));
  assert.ok(commands.includes('node "$CLAUDE_PROJECT_DIR/scripts/hooks/block-mam-unlisted.mjs"'), commands.join("\n"));
});
