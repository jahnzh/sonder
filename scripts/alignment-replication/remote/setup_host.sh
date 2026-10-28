#!/usr/bin/env bash
# Builds the worker's Python environment inside <run-dir>, without root and
# without touching anything outside it. The host has no ffmpeg/espeak and only
# Python 3.12, while worker/Dockerfile pins aeneas 1.7.3 + numpy 1.26.4 on 3.10.
# So: a private conda prefix supplies python 3.10 and ffmpeg (conda-forge has no
# espeak), the Ubuntu espeak packages are fetched with `apt-get download` and
# unpacked with `dpkg -x` into <run-dir>/apt-root (no root needed), and the venv
# is created from the conda python. Package pins mirror worker/Dockerfile.
# Usage: setup_host.sh <run-dir>
set -euo pipefail
RUN=${1:?usage: setup_host.sh <run-dir>}
RUN=$(readlink -f "$RUN")
export CONDA_PKGS_DIRS="$RUN/conda-pkgs"   # keep the package cache out of ~/miniconda
export PIP_CACHE_DIR="$RUN/pip-cache"
export HF_HOME="$RUN/alignment/models/huggingface"
CONDA=${CONDA:-$HOME/miniconda/bin/conda}

[ -x "$RUN/conda/bin/python" ] || nice -n 10 "$CONDA" create -y -q -p "$RUN/conda" -c conda-forge --override-channels \
  python=3.10 ffmpeg

mkdir -p "$RUN/apt-debs" "$RUN/apt-root"
cd "$RUN/apt-debs"
apt-get install -s --no-install-recommends espeak libespeak-dev | awk '/^Inst/ {print $2}' | xargs apt-get download
for deb in ./*.deb; do dpkg -x "$deb" "$RUN/apt-root"; done
cd "$RUN"
[ -x "$RUN/venv/bin/python" ] || "$RUN/conda/bin/python" -m venv "$RUN/venv"
export PATH="$RUN/conda/bin:$RUN/apt-root/usr/bin:$PATH"   # ffmpeg, espeak for aeneas
export LD_LIBRARY_PATH="$RUN/apt-root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# aeneas builds its C extensions against libespeak; point the compiler at the unpacked -dev files
export CFLAGS="-I$RUN/apt-root/usr/include" CPATH="$RUN/apt-root/usr/include"
export LDFLAGS="-L$RUN/apt-root/usr/lib/x86_64-linux-gnu" LIBRARY_PATH="$RUN/apt-root/usr/lib/x86_64-linux-gnu"
PIP="nice -n 10 $RUN/venv/bin/pip install --no-cache-dir"
$PIP 'numpy==1.26.4' 'setuptools<70' wheel
$PIP --no-build-isolation 'aeneas==1.7.3'
$PIP 'fastapi==0.121.3' 'uvicorn==0.38.0' 'psutil==7.1.3' 'faster-whisper==1.2.1'

# Models: worker/download_model.py reads MEDIA_ROOT, so point it at the run dir.
mkdir -p "$RUN/alignment"
cd "$RUN/repo/worker"
MEDIA_ROOT="$RUN" nice -n 10 "$RUN/venv/bin/python" download_model.py
