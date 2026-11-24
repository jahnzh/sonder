# Environment for the recap prototype on the WSL host. Source it: `. ~/recap-proto/wsl/env.sh`.
# It only sets variables in the calling shell. Nothing here touches ~/sonder-ctc-worker.
export RECAP_HOME="${RECAP_HOME:-$HOME/recap-proto}"
export LLAMA_BUILD="${LLAMA_BUILD:-b12589}"
export LLAMA_DIR="$RECAP_HOME/llama/$LLAMA_BUILD/llama-$LLAMA_BUILD"
export LLAMA_CUDART="$RECAP_HOME/llama/$LLAMA_BUILD/cudart-llama-$LLAMA_BUILD-bin-ubuntu-cuda-13.5-x64"
# /usr/lib/wsl/lib holds the driver's libcuda and nvidia-smi inside WSL2.
export LD_LIBRARY_PATH="$LLAMA_DIR:$LLAMA_CUDART:/usr/lib/wsl/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PATH="$LLAMA_DIR:/usr/lib/wsl/lib:$PATH"
export RECAP_PORT="${RECAP_PORT:-8091}"
