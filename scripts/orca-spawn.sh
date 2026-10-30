#!/usr/bin/env bash
# Start an Orca worker with a required model, after the preflight.
#   orca-spawn.sh --spec-file <file> --name <worktree> (--base <branch> | --base-worktree <name>) --agent <id> --model <id> [--effort <level>] [--doc <path>...]
# Exactly one of --base and --base-worktree is required. --base-worktree uses the branch checked out in the worktree
# <name> under the workspaces directory, so the local branch name need not match the remote one.
# Without --doc the preflight checks AGENTS.md and CLAUDE.md on the base.
# After the launch the script prints "branch: <name>", the local branch of the new worktree, for push and cleanup.
# Exit codes: 0 worker started with the requested model, 1 a check or the launch failed, 2 bad usage.
# ORCA_SPAWN_WORKSPACES overrides the workspaces directory (tests); ORCA_CLI_COMMAND the orca binary.
# The launch receipt is read as JSON: {"ok": true, "result": {"dispatchId", "launch": {"effective": {"model"}}, "effects": [...]}}.
# The worktree path comes from result.effects. codegraph init -y runs in the background, so a worker that
# starts at once may call CodeGraph before the index exists; it builds its own if .codegraph is missing.
# After a successful launch it also runs `orca-history.mjs capture --dispatch <id>` (failures are warnings only).
# Once worker-start has succeeded the script never exits non-zero, so a caller cannot start a second worker.
set -u

usage() {
  echo "usage: orca-spawn.sh --spec-file <file> --name <worktree> (--base <branch> | --base-worktree <name>) --agent <id> --model <id> [--effort <level>] [--doc <path>...]" >&2
  exit 2
}

spec_file="" name="" base="" base_worktree="" agent="" model="" effort=""
docs=()
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case $1 in
    --spec-file) spec_file=$2 ;;
    --name) name=$2 ;;
    --base) base=$2 ;;
    --base-worktree) base_worktree=$2 ;;
    --agent) agent=$2 ;;
    --model) model=$2 ;;
    --effort) effort=$2 ;;
    --doc) docs+=("$2") ;;
    *) usage ;;
  esac
  shift 2
done

if [ -z "$model" ]; then
  echo "refusing to spawn without --model" >&2
  usage
fi
[ -n "$spec_file" ] && [ -n "$name" ] && [ -n "$agent" ] || usage
# Exactly one of --base and --base-worktree.
if [ -n "$base" ] && [ -n "$base_worktree" ]; then
  echo "use either --base or --base-worktree, not both" >&2
  usage
fi
[ -n "$base" ] || [ -n "$base_worktree" ] || usage
if [ ! -f "$spec_file" ]; then
  echo "spec file not found: $spec_file" >&2
  exit 2
fi

if [ "$agent" = "cursor" ]; then
  if ! models=$(agent --list-models 2>&1); then
    echo "agent --list-models failed:" >&2
    echo "$models" >&2
    exit 1
  fi
  if ! printf '%s\n' "$models" | awk -v m="$model" '$1 == m { found = 1 } END { exit !found }'; then
    echo "unknown cursor model: $model (see agent --list-models)" >&2
    exit 1
  fi
fi

[ ${#docs[@]} -gt 0 ] || docs=(AGENTS.md CLAUDE.md)

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
workspaces=${ORCA_SPAWN_WORKSPACES:-/home/jahn/orca/workspaces/audiobook_streamer}
worktree=$workspaces/$name

if [ -n "$base_worktree" ]; then
  base=$(git -C "$workspaces/$base_worktree" branch --show-current 2>/dev/null)
  if [ -z "$base" ]; then
    echo "cannot resolve a branch from worktree $workspaces/$base_worktree (missing, not a git worktree, or detached HEAD)" >&2
    exit 1
  fi
  echo "base branch: $base (from worktree $base_worktree)"
fi

# One command-line argument is limited to about 128 KiB (MAX_ARG_STRLEN), and worker-start takes the spec as one
# argument. Refuse early, before anything is started, with a message the caller can act on.
spec_bytes=$(wc -c < "$spec_file")
if [ "$spec_bytes" -gt 120000 ]; then
  echo "spec file is $spec_bytes bytes; a single argument is limited to about 131072. Shorten it, or put the long text in a file in the repository and name that file in the spec." >&2
  exit 1
fi

if ! out=$(bash "$root/scripts/orca-preflight.sh" "$base" "$worktree" "${docs[@]}" 2>&1); then
  echo "preflight failed:"
  echo "$out"
  exit 1
fi

args=(orchestration worker-start --spec "$(cat "$spec_file")" --worktree new-top-level
  --name "$name" --repo "path:$root" --base-branch "$base" --agent "$agent" --model "$model")
[ -z "$effort" ] || args+=(--effort "$effort")
args+=(--json)

receipt=$(${ORCA_CLI_COMMAND:-orca} "${args[@]}" 2>&1)
status=$?

# The receipt may follow non-JSON or keepalive lines; take the last line that starts a JSON object.
parsed=$(printf '%s\n' "$receipt" | node -e '
  const lines = require("fs").readFileSync(0, "utf8").split("\n");
  const start = lines.map((l) => l.trimStart().startsWith("{")).lastIndexOf(true);
  let r;
  for (let i = start; i >= 0 && !r; i--) {
    if (!lines[i].trimStart().startsWith("{")) continue;
    try { r = JSON.parse(lines.slice(i).join("\n")); } catch {}
  }
  if (!r) process.exit(3);
  // The real receipt is {"ok": true, "result": {"dispatchId": ..., "launch": {"requested": {...}, "effective": {"model": ...}}}}.
  // The top-level "id" is the request id, not the dispatch id, so it is never used.
  const pick = (...v) => v.find((x) => typeof x === "string" && x);
  const res = r.result ?? r;
  const d = res.dispatch ?? {};
  // effects[] has {"kind":"worktree","id":"<repo id>::<worktree path>"} for the worktree Orca created.
  const wt = (res.effects ?? []).find((e) => e && e.kind === "worktree" && typeof e.id === "string");
  const wtPath = wt ? wt.id.slice(wt.id.indexOf("::") + 2) : "";
  console.log([
    r.ok === true ? "true" : "false",
    pick(res.dispatchId, d.id, d.dispatchId) ?? "",
    pick(res.launch?.effective?.model, res.effectiveModel, res.model, d.model) ?? "",
    wtPath,
  ].join("\t"));
') || { echo "worker-start gave no JSON receipt (exit $status):" >&2; echo "$receipt" >&2; exit 1; }

IFS=$'\t' read -r ok dispatch effective receipt_worktree <<< "$parsed"
echo "dispatch: ${dispatch:-unknown}"
echo "effective model: ${effective:-unknown}"

if [ "$ok" != "true" ] || [ "$status" -ne 0 ]; then
  echo "worker-start did not succeed (ok=$ok, exit $status):" >&2
  echo "$receipt" >&2
  exit 1
fi
if [ "$effective" != "$model" ]; then
  echo "effective model '${effective:-unknown}' differs from requested '$model'" >&2
  exit 1
fi

# The worker is already running, so nothing below may fail the script: a non-zero exit makes the caller retry
# and start a second worker. Prefer the path Orca reports; fall back to the guessed one.
[ -z "$receipt_worktree" ] || worktree=$receipt_worktree
if [ -d "$worktree" ]; then
  (cd "$worktree" && nohup codegraph init -y > .codegraph-init.log 2>&1 &)
  echo "codegraph init -y running in the background in $worktree (log: .codegraph-init.log)"
  # Orca may name the local branch differently from the base (user/name); push and clean up with this one.
  if branch=$(git -C "$worktree" branch --show-current 2>/dev/null) && [ -n "$branch" ]; then
    echo "branch: $branch"
  else
    echo "warning: could not read the branch of $worktree" >&2
  fi
else
  echo "warning: worktree $worktree not found; the worker is running. Run codegraph init -y there once it exists." >&2
fi

# Automatic history capture at dispatch. Failures are warnings only — the worker is already running.
# ORCA_HISTORY_SCRIPT overrides the capture entry point (tests); unset ORCA_HISTORY_AUTO=0 to skip.
if [ -n "${dispatch:-}" ] && [ "${ORCA_HISTORY_AUTO:-1}" != "0" ]; then
  history_script="${ORCA_HISTORY_SCRIPT:-$root/scripts/orca-history.mjs}"
  if capture_out=$(node "$history_script" capture --dispatch "$dispatch" 2>&1); then
    echo "history: captured $dispatch"
  else
    echo "warning: automatic history capture failed for $dispatch (worker still running): $capture_out" >&2
  fi
fi
