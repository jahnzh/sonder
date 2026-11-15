"""Wall-clock limits for alignment work. Standard library only, so it runs without fastapi."""
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

def worker_slots(env=None):
    """Requests one worker process runs at once (ALIGNMENT_WORKER_SLOTS, 1-16). They share its resident model."""
    env = os.environ if env is None else env
    raw = env.get("ALIGNMENT_WORKER_SLOTS", "1")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = 0
    if not 1 <= value <= 16:
        print(f"Ignoring ALIGNMENT_WORKER_SLOTS={raw!r}: expected a whole number from 1 to 16. Using 1.", file=sys.stderr)
        return 1
    return value

class Gate:
    """The worker's job slots: up to `slots` requests at a time, with the oldest one's age and the last timeout visible.

    A job whose child survived the kill keeps its slot until that process is gone, so the next job never runs
    next to a runaway one; /health shows it as stuck."""
    def __init__(self, slots=1):
        self.slots = max(1, int(slots))
        self._lock = threading.Lock()
        self._started = {}
        self._stuck = set()
        self.last_timeout = None

    @property
    def active(self):
        with self._lock:
            return len(self._started)

    @property
    def busy(self):
        """True when every slot is taken."""
        return self.active >= self.slots

    @property
    def stuck(self):
        with self._lock:
            return bool(self._stuck)

    def busy_seconds(self):
        with self._lock:
            oldest = min(self._started.values(), default=None)
        return round(time.monotonic() - oldest, 1) if oldest is not None else None

    def _free(self, token):
        with self._lock:
            self._started.pop(token, None)
            self._stuck.discard(token)

    def _release_when_gone(self, process, token):
        try:
            process.wait()
        finally:
            self._free(token)

    @contextmanager
    def hold(self):
        token = object()
        with self._lock:
            if len(self._started) >= self.slots:
                raise WorkerBusy()
            self._started[token] = time.monotonic()
        survivor = None
        try:
            yield
        except AlignmentTimeout as error:
            self.last_timeout = datetime.now(timezone.utc).isoformat(timespec="seconds")
            survivor = error.stuck
            raise
        finally:
            if survivor is not None and survivor.poll() is None:
                with self._lock:
                    self._stuck.add(token)
                threading.Thread(target=self._release_when_gone, args=(survivor, token), daemon=True).start()
            else:
                self._free(token)

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
