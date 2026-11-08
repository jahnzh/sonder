"""Sample GPU utilization while the worker is busy. Null on hosts without a GPU."""
import shutil
import subprocess
import threading
import time
from pathlib import Path


def nvidia_smi_bin():
    found = shutil.which("nvidia-smi")
    if found:
        return found
    wsl = Path("/usr/lib/wsl/lib/nvidia-smi")
    return str(wsl) if wsl.is_file() else None


def read_gpu_utilization(bin_path=None):
    """Return utilization.gpu percent (0-100) or None when unavailable."""
    binary = bin_path or nvidia_smi_bin()
    if not binary:
        return None
    try:
        completed = subprocess.run(
            [binary, "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    for line in completed.stdout.splitlines():
        token = line.strip().split(",")[0].strip()
        if token.isdigit():
            return int(token)
    return None


class GpuMonitor:
    """1 Hz sampler for the duration of one busy hold."""

    def __init__(self, interval=1.0, reader=read_gpu_utilization):
        self.interval = interval
        self.reader = reader
        self.samples = []
        self._stop = threading.Event()
        self._thread = None

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *_):
        self.stop()

    def start(self):
        if self._thread is not None:
            return
        self._stop.clear()
        self.samples = []
        first = self.reader()
        if first is None:
            return
        self.samples.append(first)

        def loop():
            while not self._stop.wait(self.interval):
                value = self.reader()
                if value is not None:
                    self.samples.append(value)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        thread = self._thread
        self._thread = None
        if thread is not None:
            thread.join(timeout=self.interval + 1)

    def mean(self):
        if not self.samples:
            return None
        return sum(self.samples) / len(self.samples)
