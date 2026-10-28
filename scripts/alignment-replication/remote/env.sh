# Sourced by the remote scripts. Expects RUN to be the absolute run directory.
export PATH="$RUN/conda/bin:$RUN/apt-root/usr/bin:$PATH"
export LD_LIBRARY_PATH="$RUN/apt-root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export ESPEAK_DATA_PATH="$RUN/apt-root/usr/lib/x86_64-linux-gnu"
export HF_HOME="$RUN/alignment/models/huggingface"
export PYTHONIOENCODING=UTF-8 PYTHONUNBUFFERED=1
# Same thread limits as worker/Dockerfile
export OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2
