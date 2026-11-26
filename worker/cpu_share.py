"""The host's CPU cores among the book jobs running on one worker at once (#913).

A whole-book encode on the CPU takes, before each batch, the cores no other running work claims: all of
them while it runs alone, fewer from the next batch on once another book decodes or aligns beside it, and
all of them again when that ends. A book's decode claims its ffmpeg processes and its align stage claims
the job's thread plus its process pool, for as long as they run. Window requests claim nothing here: an
encode batch starts only while no window request runs or waits (`deadline.Gate.hold_background`), and a
window request sets its own share of threads for its own forward passes (`ctc_acoustic`).
"""
import os
import threading
from contextlib import contextmanager


def host_cores():
    """The cores this process may run on (its affinity mask, else every core the host reports)."""
    try:
        return len(os.sched_getaffinity(0)) or 1
    except (AttributeError, OSError):
        return os.cpu_count() or 1


def physical_cores(topology="/sys/devices/system/cpu"):
    """The physical cores among this process's CPUs: one per set of hyperthread siblings (Linux sysfs), else
    `host_cores()`. lisa: 10 of its 20."""
    try:
        cpus = sorted(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        return host_cores()
    siblings = set()
    for cpu in cpus:
        try:
            with open(f"{topology}/cpu{cpu}/topology/thread_siblings_list") as handle:
                siblings.add(handle.read().strip())
        except OSError:
            return host_cores()
    return len(siblings) or host_cores()


class CpuShare:
    def __init__(self, cores=None):
        self._cores = cores
        # Guards the claims only; never held across I/O or a callback.
        self._lock = threading.Lock()
        self._claims = {}

    @property
    def cores(self):
        return self._cores or host_cores()

    @contextmanager
    def claim(self, cores):
        """Count `cores` as taken while the block runs."""
        token = object()
        with self._lock:
            self._claims[token] = max(0, int(cores))
        try:
            yield
        finally:
            with self._lock:
                self._claims.pop(token, None)

    def claimed(self):
        with self._lock:
            return sum(self._claims.values())

    def free(self):
        """The cores no running claim holds, at least 1."""
        return max(1, self.cores - self.claimed())


SHARE = CpuShare()
