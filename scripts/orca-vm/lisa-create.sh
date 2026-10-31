#!/usr/bin/env bash
set -euo pipefail

# Persistent SSH host recipe for lisa. Prints one connection JSON object on stdout;
# progress and errors go to stderr.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_file="${script_dir}/lisa-state.json"

json_value() {
  local key="$1"
  node -e '
    const fs = require("fs");
    const key = process.argv[1];
    const path = process.argv[2];
    let data = {};
    try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
    const value = data[key];
    if (value === undefined || value === null) process.exit(0);
    process.stdout.write(String(value));
  ' "$key" "$state_file"
}

env_value() {
  local name="$1"
  if [ -n "${!name:-}" ]; then
    printf '%s' "${!name}"
  fi
}

resolve() {
  local env_name="$1"
  local state_key="$2"
  local fallback="${3:-}"
  local value
  value="$(env_value "$env_name")"
  if [ -z "$value" ]; then
    value="$(json_value "$state_key")"
  fi
  if [ -z "$value" ]; then
    value="$fallback"
  fi
  printf '%s' "$value"
}

host="$(resolve ORCA_SSH_HOST host)"
ssh_port="$(resolve ORCA_SSH_PORT sshPort 22)"
ssh_username="$(resolve ORCA_SSH_USERNAME sshUsername)"
identity_file="$(resolve ORCA_SSH_IDENTITY_FILE identityFile)"
jump_host="$(resolve ORCA_SSH_JUMP_HOST jumpHost "")"
proxy_command="$(resolve ORCA_SSH_PROXY_COMMAND proxyCommand "")"
project_root="$(resolve ORCA_PROJECT_ROOT projectRoot)"
repo_url="$(resolve ORCA_REPO_URL repoUrl)"
repo_ref="$(resolve ORCA_REPO_REF repoRef main)"
: "${identity_file:=}"
: "${jump_host:=}"
: "${proxy_command:=}"

[ -n "$host" ] || { echo "missing ssh host" >&2; exit 1; }
[ -n "$ssh_username" ] || { echo "missing ssh username" >&2; exit 1; }
[ -n "$project_root" ] || { echo "missing projectRoot" >&2; exit 1; }
[ -n "$repo_url" ] || { echo "missing repoUrl" >&2; exit 1; }

if [ -n "$jump_host" ] && [ -n "$proxy_command" ]; then
  echo "set jump_host or proxy_command, not both" >&2
  exit 1
fi

ssh_target="${ssh_username}@${host}"
ssh_opts=(-p "$ssh_port" -o BatchMode=yes -o StrictHostKeyChecking=yes)
[ -n "$identity_file" ] && ssh_opts+=(-i "$identity_file" -o IdentitiesOnly=yes)
[ -n "$jump_host" ] && ssh_opts+=(-J "$jump_host")
[ -n "$proxy_command" ] && ssh_opts+=(-o "ProxyCommand=$proxy_command")

echo "syncing ${repo_url}@${repo_ref} -> ${ssh_target}:${project_root}" >&2

remote_sync='set -euo pipefail
  export GIT_TERMINAL_PROMPT=0
  export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
  mkdir -p "$(dirname "$project_root")"
  if [ ! -d "$project_root/.git" ]; then
    git clone "$repo_url" "$project_root"
  fi
  cd "$project_root"
  git fetch origin "$repo_ref"
  git checkout -B "$repo_ref" FETCH_HEAD
  command -v node >/dev/null
  command -v agy >/dev/null
  command -v git >/dev/null
  pwd'

ssh "${ssh_opts[@]}" "$ssh_target" "$(printf \
  'project_root=%q repo_url=%q repo_ref=%q bash -lc %q' \
  "$project_root" "$repo_url" "$repo_ref" "$remote_sync")" >&2

node -e '
  const [host, port, user, idf, jh, pc, root] = process.argv.slice(1);
  const target = {
    label: "lisa",
    host,
    port: Number(port),
    username: user,
    identitiesOnly: true,
  };
  if (idf) target.identityFile = idf;
  if (jh) target.jumpHost = jh;
  if (pc) target.proxyCommand = pc;
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    connection: {
      type: "ssh",
      projectRoot: root,
      target,
    },
    userData: {
      provider: "ssh-host",
      resourceId: "lisa",
      agentCli: "agy",
      agentModel: "gemini-3.8-flash-medium",
    },
  }) + "\n");
' "$host" "$ssh_port" "$ssh_username" "$identity_file" "$jump_host" "$proxy_command" "$project_root"
