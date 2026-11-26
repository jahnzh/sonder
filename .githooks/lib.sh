#!/usr/bin/env bash
# Shared by the hooks in this folder. Not a hook itself.

# A file that neither the typecheck nor the build reads: anything under docs/, and any markdown file.
is_documentation() {
  case "$1" in
    docs/* | *.md) return 0 ;;
    *) return 1 ;;
  esac
}

# Whether this checkout has its dependencies. An Orca worktree on the coordinator host has no node_modules:
# there the typecheck, build and tests run in the land gate (npm run ci:run), not in a hook.
has_dependencies() {
  local top
  top="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  [[ -d "$top/node_modules" ]]
}
