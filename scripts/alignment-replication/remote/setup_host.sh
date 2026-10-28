#!/usr/bin/env bash
# Builds the worker's Python environment inside <run-dir>, without root and
# without touching anything outside it. The host has no ffmpeg/espeak and only
# Python 3.12, while worker/Dockerfile pins aeneas 1.7.3 + numpy 1.26.4 on 3.10,
# so a private conda prefix supplies python 3.10, ffmpeg and espeak-ng and the
# venv is created from that python. Package pins mirror worker/Dockerfile.
# Usage: setup_host.sh <run-dir>
set -euo pipefail
RUN=${1:?usage: setup_host.sh <run-dir>}
RUN=$(readlink -f "$RUN")
export CONDA_PKGS_DIRS="$RUN/conda-pkgs"   # keep the package cache out of ~/miniconda
export PIP_CACHE_DIR="$RUN/pip-cache"
export HF_HOME="$RUN/alignment/models/huggingface"
CONDA=${CONDA:-$HOME/miniconda/bin/conda}

nice -n 10 "$CONDA" create -y -q -p "$RUN/conda" -c conda-forge --override-channels \
  python=3.10 ffmpeg espeak-ng
"$RUN/conda/bin/python" -m venv "$RUN/venv"
export PATH="$RUN/conda/bin:$PATH"          # ffmpeg, espeak for aeneas
PIP="nice -n 10 $RUN/venv/bin/pip install --no-cache-dir"
$PIP 'numpy==1.26.4' 'setuptools<70' wheel
$PIP --no-build-isolation 'aeneas==1.7.3'
$PIP 'fastapi==0.121.3' 'uvicorn==0.38.0' 'psutil==7.1.3' 'faster-whisper==1.2.1'

# Models: worker/download_model.py reads MEDIA_ROOT, so point it at the run dir.
mkdir -p "$RUN/alignment"
cd "$RUN/repo/worker"
MEDIA_ROOT="$RUN" nice -n 10 "$RUN/venv/bin/python" download_model.py
