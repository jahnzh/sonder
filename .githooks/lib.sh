#!/usr/bin/env bash
# Shared by the hooks in this folder. Not a hook itself.

# A file that neither the typecheck nor the build reads: anything under docs/, and any markdown file.
is_documentation() {
  case "$1" in
    docs/* | *.md) return 0 ;;
    *) return 1 ;;
  esac
}
