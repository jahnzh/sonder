#!/usr/bin/env bash
# Updates the alignment worker code on the pool hosts to a commit, one host after the other.
#   scripts/update-ctc-workers.sh <commit> [--dry-run] [--host <ssh name>]...
# Hosts default to SONDER_CTC_HOSTS, else "192.168.1.119 lisa" (WSL's GPU, lisa's CPU). On each host, in
# ~/sonder-ctc-worker (SONDER_CTC_DIR overrides):
#   1. skip it when /health already reports this commit as its revision, or a commit with the same worker/;
#   2. copy worker/ of the commit to worker.new and write the commit into worker.new/REVISION;
#   3. refuse when /health shows a request or a whole-book job running;
#   4. install worker.new/requirements-book.txt into the host's env when its pins are not all there (#921), fetch
#      the pinned model weights that are missing (download_model.py, checked by SHA-256), import the new code with
#      the host's own environment (worker.env), so a broken copy never goes live, and refuse again when busy;
#   5. move worker to worker.bak-<time>, worker.new to worker, restart the systemd user unit;
#   6. wait until /health is ready and reports the commit; 7. keep the two newest worker.bak-* folders.
# A failure on a host stops the script; the old code is in worker.bak-<time> (move it back and restart).
# scripts/install-ctc-workers.sh sets up a new host; this script only replaces the code of an installed one.
set -euo pipefail

usage() {
  sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

commit=""
dry_run=0
hosts=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) dry_run=1; shift ;;
    --host) [[ $# -ge 2 ]] || usage; hosts+=("$2"); shift 2 ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) [[ -z $commit ]] || usage; commit=$1; shift ;;
  esac
done
[[ -n $commit ]] || usage
if [[ ${#hosts[@]} -eq 0 ]]; then
  read -r -a hosts <<<"${SONDER_CTC_HOSTS:-192.168.1.119 lisa}"
fi

# The repository by its git directory, not its work tree: the production directory is a bare repository
# (core.bare=true), where --show-toplevel fails with "must be run in a work tree" (deploy-prod.sh's layout). Everything
# below reads commits only (rev-parse, archive, cat-file, diff of two commits), which a bare repository answers.
git_dir=$(git -C "$(dirname "$0")" rev-parse --absolute-git-dir)
repo_git() { git --git-dir="$git_dir" "$@"; }
revision=$(repo_git rev-parse --verify "$commit^{commit}")
remote_dir=${SONDER_CTC_DIR:-sonder-ctc-worker}
unit=sonder-ctc-worker.service
ssh_cmd=${SONDER_CTC_SSH:-ssh}
rsync_cmd=${SONDER_CTC_RSYNC:-rsync}

stage=$(mktemp -d "${TMPDIR:-/tmp}/sonder-ctc-update-XXXXXX")
trap 'rm -rf "$stage"' EXIT
repo_git archive "$revision" worker | tar -x -C "$stage"
printf '%s\n' "$revision" >"$stage/worker/REVISION"

for host in "${hosts[@]}"; do
  echo "== $host"
  current=$($ssh_cmd "$host" 'curl -s -m 5 http://127.0.0.1:3012/health' | node -e '
    let text = ""; process.stdin.on("data", (c) => (text += c)); process.stdin.on("end", () => {
      try { console.log(JSON.parse(text).revision ?? "unknown"); } catch { console.log("no answer"); }
    });')
  if [[ $current == "$revision" ]]; then
    echo "already at ${revision:0:7}"
    continue
  fi
  # A commit that leaves worker/ as it is needs no copy and no restart; the host keeps reporting its older commit.
  if [[ $current =~ ^[0-9a-f]{40}$ ]] && repo_git cat-file -e "$current^{commit}" 2>/dev/null &&
    repo_git diff --quiet "$current" "$revision" -- worker; then
    echo "runs ${current:0:7}: worker/ is the same at ${revision:0:7}"
    continue
  fi
  echo "runs ${current:0:12}, wants ${revision:0:7}"
  if [[ $dry_run -eq 1 ]]; then
    echo "dry run: would copy, test, swap and restart"
    continue
  fi

  $rsync_cmd -a --delete --exclude __pycache__ "$stage/worker/" "$host:$remote_dir/worker.new/"
  $ssh_cmd "$host" bash -s -- "$remote_dir" "$unit" "$revision" <<'REMOTE'
set -euo pipefail
dir=$HOME/$1
unit=$2
revision=$3
cd "$dir/worker.new"
refuse_when_busy() {
  local busy
  busy=$(curl -s -m 5 http://127.0.0.1:3012/health | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("activeRequests", 0), d.get("busy", False), (d.get("bookJobs") or {}).get("jobs", 0))
except Exception:
    print("no answer")')
  case $busy in
    "0 False 0"|"no answer") ;;
    *) echo "worker is busy ($busy): not swapping" >&2; exit 3 ;;
  esac
}
# Before the packages change (#921): a running SEW-D tiny encode imports transformers from this env.
refuse_when_busy
if [ -f requirements-book.txt ]; then
  if ! ../env/bin/python -B - requirements-book.txt <<'PY'
import sys
from importlib.metadata import PackageNotFoundError, version
pins = [line.split("#")[0].strip() for line in open(sys.argv[1])]
for name, wanted in (pin.split("==", 1) for pin in pins if "==" in pin):
    try:
        if version(name) != wanted:
            sys.exit(1)
    except PackageNotFoundError:
        sys.exit(1)
PY
  then
    ../env/bin/pip install -q --no-cache-dir -r requirements-book.txt
    echo "installed requirements-book.txt"
  fi
fi
(set -a; . ../worker.env; set +a; ../env/bin/python -B download_model.py)
(set -a; . ../worker.env; set +a; ../env/bin/python -B -c 'import align; align.health()')
echo "import ok"

refuse_when_busy  # again: a request may have come in while the packages and weights were set up

cd "$dir"
stamp=$(date +%s)
mv worker "worker.bak-$stamp"
mv worker.new worker
systemctl --user restart "$unit"
ready=""
for _ in $(seq 1 60); do
  sleep 3
  ready=$(curl -s -m 3 http://127.0.0.1:3012/health | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("revision") if d.get("ready") else "")
except Exception:
    print("")' || true)
  [ "$ready" = "$revision" ] && break
done
if [ "$ready" != "$revision" ]; then
  echo "worker did not come back ready at $revision; old code is in $dir/worker.bak-$stamp" >&2
  exit 4
fi
echo "ready at ${revision:0:7}; old code in worker.bak-$stamp"
ls -d worker.bak-* | sort | head -n -2 | while read -r old; do rm -rf "$old"; done
REMOTE
done
