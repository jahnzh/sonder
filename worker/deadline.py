"""Wall-clock limits for alignment work. Standard library only, so it runs without fastapi or aeneas."""
import ctypes
import math
import os
import signal
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

# limit = min(ceiling, base + per_second * audio seconds). Every value can be overridden
# by an environment variable; one outside its range is ignored and the default is used.
DEFAULTS = {
    "ALIGNMENT_TIMEOUT_BASE_SECONDS": 120.0,
    "ALIGNMENT_TIMEOUT_PER_AUDIO_SECOND": 0.15,
    "ALIGNMENT_TIMEOUT_MAX_SECONDS": 1200.0,
}
# The server stops waiting after 30 minutes (3 for /anchor). The worker's own limit must
# stay below that so its clear 504 reaches the user instead of a client-side abort.
LIMIT_RANGES = {
    "ALIGNMENT_TIMEOUT_BASE_SECONDS": (0.0, 1500.0),
    "ALIGNMENT_TIMEOUT_PER_AUDIO_SECOND": (0.0, 1.0),
    "ALIGNMENT_TIMEOUT_MAX_SECONDS": (1.0, 1700.0),
}
# The kill path itself can take KILL_WAIT_SECONDS + REAP_SECONDS, so the ceiling plus that must stay under the
# server's 180 s wait for /anchor (tests/worker pins the sum).
KILL_WAIT_SECONDS = 5.0
REAP_SECONDS = 2.0
ANCHOR_CEILING = 150.0

class AlignmentTimeout(Exception):
    def __init__(self, seconds, stuck=None):
        # `stuck` is the child process when the kill did not end it (for example a read blocked on a failing disk).
        self.stuck = stuck
        self.seconds = round(seconds)
        super().__init__(f"Local alignment timed out after {self.seconds} seconds. "
                         "The section is too long for this worker or the worker is overloaded. "
                         "Retry later, or choose a release with chapters.")

class AlignmentFailed(Exception):
    pass

class WorkerBusy(Exception):
    pass

def _setting(env, name):
    default = DEFAULTS[name]
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    low, high = LIMIT_RANGES[name]
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    # The ceiling must be positive; the base and the per-second rate may be zero.
    if not math.isfinite(value) or not low <= value <= high or (name.endswith("MAX_SECONDS") and value <= 0):
        print(f"Ignoring {name}={raw!r}: expected a number from {low:g} to {high:g}. Using {default:g}.", file=sys.stderr)
        return default
    return value

def alignment_limit(duration, env=None):
    """Seconds an /align request may spend, including audio extraction."""
    env = os.environ if env is None else env
    base = _setting(env, "ALIGNMENT_TIMEOUT_BASE_SECONDS")
    per_second = _setting(env, "ALIGNMENT_TIMEOUT_PER_AUDIO_SECOND")
    ceiling = _setting(env, "ALIGNMENT_TIMEOUT_MAX_SECONDS")
    return min(ceiling, base + per_second * duration)

def anchor_limit(duration, env=None):
    return min(ANCHOR_CEILING, alignment_limit(duration, env))

class Gate:
    """The single job slot: one request at a time, with its age and last timeout visible.

    A job whose child survived the kill keeps the slot until that process is gone, so the next job never runs
    next to a runaway one; /health shows it as stuck."""
    def __init__(self):
        self._lock = threading.Lock()
        self._started = None
        self.last_timeout = None
        self.stuck = False

    @property
    def busy(self):
        return self._lock.locked()

    def busy_seconds(self):
        started = self._started
        return round(time.monotonic() - started, 1) if started is not None else None

    def _release_when_gone(self, process):
        try:
            process.wait()
        finally:
            self._started = None
            self.stuck = False
            self._lock.release()

    @contextmanager
    def hold(self):
        if not self._lock.acquire(blocking=False):
            raise WorkerBusy()
        self._started = time.monotonic()
        survivor = None
        try:
            yield
        except AlignmentTimeout as error:
            self.last_timeout = datetime.now(timezone.utc).isoformat(timespec="seconds")
            survivor = error.stuck
            raise
        finally:
            if survivor is not None and survivor.poll() is None:
                self.stuck = True
                threading.Thread(target=self._release_when_gone, args=(survivor,), daemon=True).start()
            else:
                self._started = None
                self._lock.release()

_subreaper = False

def _adopt_orphans():
    """Make this process the parent of any grandchild a killed job leaves behind, so it can be reaped."""
    global _subreaper
    if _subreaper:
        return
    _subreaper = True
    try:
        ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
    except Exception:
        pass

def _kill_group(process):
    """SIGKILL the process group and wait for the child. Returns True when the child is gone."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        process.kill()
    try:
        process.communicate(timeout=KILL_WAIT_SECONDS)
    except Exception:
        pass
    # Reap what the group left behind: a dead process stays visible until its parent waits.
    give_up = time.monotonic() + REAP_SECONDS
    while time.monotonic() < give_up:
        try:
            if os.waitpid(-process.pid, os.WNOHANG) == (0, 0):
                time.sleep(0.02)
        except ChildProcessError:
            break
    return process.poll() is not None

def run_with_deadline(command, deadline, limit, env=None):
    """Run a command in its own process group and kill the whole group at `deadline` (a time.monotonic() value).

    Returns (returncode, stderr tail). Raises AlignmentTimeout(limit) when the deadline passes."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise AlignmentTimeout(limit)
    _adopt_orphans()
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE, start_new_session=True, env=env)
    try:
        _, error = process.communicate(timeout=remaining)
    except subprocess.TimeoutExpired:
        gone = _kill_group(process)
        raise AlignmentTimeout(limit, stuck=None if gone else process) from None
    except BaseException:
        _kill_group(process)
        raise
    return process.returncode, error.decode("utf-8", "replace")[-2000:]
