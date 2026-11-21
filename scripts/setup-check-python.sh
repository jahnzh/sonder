#!/usr/bin/env bash
# Gives a check host the Python the alignment worker's tests need (tests/worker, run by
# tests/0-worker-python.test.ts): a virtual environment in the user's home, nothing system-wide, no password.
#
#   bash scripts/setup-check-python.sh [<directory>]      # default ~/sonder-ci-python
#
# Run it on the host itself, or from here:  ssh <host> 'bash -s' < scripts/setup-check-python.sh
# (then the requirements are the list below, not the file). Running it again upgrades nothing and is harmless.
# Afterwards name the interpreter in scripts/ci-hosts.json as the host's "workerPython": the check then runs the
# worker's tests with it and FAILS when it cannot import what they need, instead of skipping them.
set -euo pipefail
target=${1:-$HOME/sonder-ci-python}
requirements="numpy fastapi uvicorn httpx"
here=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
if [[ -n $here && -f $here/../tests/worker/requirements-check.txt ]]; then
  requirements=$(grep -vE '^\s*(#|$)' "$here/../tests/worker/requirements-check.txt" | tr '\n' ' ')
fi
command -v python3 >/dev/null || { echo "setup-check-python: python3 is not installed" >&2; exit 1; }
if [[ ! -x $target/bin/python3 ]]; then
  python3 -m venv "$target" || { echo "setup-check-python: python3 -m venv failed; the host needs the python3-venv package (that one does need an administrator)" >&2; exit 1; }
fi
# shellcheck disable=SC2086
"$target/bin/python3" -m pip install --quiet --disable-pip-version-check $requirements
"$target/bin/python3" - <<'PY'
import sys, numpy, fastapi, uvicorn, httpx
print(f"setup-check-python: {sys.executable} python {sys.version.split()[0]}, numpy {numpy.__version__}, fastapi {fastapi.__version__}, uvicorn {uvicorn.__version__}, httpx {httpx.__version__}")
PY
