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

class GateWaitStopped(Exception):
    """A background holder stopped waiting for the gate (its job was cancelled)."""

# Background work (whole-book encode batches) yields to the window endpoints: it takes a free slot only
# when no window request runs or waits, none ended in the last WINDOW_GRACE_S (a window job's next request
# follows within it), and no refused window request is still due to retry (the server retries a 409
# after 3 s; WINDOW_RETRY_S bounds the wait for one that never comes back).
WINDOW_GRACE_S = 2.0
WINDOW_RETRY_S = 5.0
# A window request that finds a book batch on the device waits for it; a batch is a fraction of a second
# on the GPU and at most a few seconds on a CPU (docs/CTC_WORKER_POOL.md). Past this the batch is taken
# to be hung and the request is refused as busy, as when every slot is taken, so the server retries.
WINDOW_WAIT_MAX_S = 60.0

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

def _report_wait(on_wait, waiting):
    """Call a background holder's wait report; its failure (a status write on a full disk) is only logged."""
    if on_wait is None:
        return
    try:
        on_wait(waiting)
    except Exception as error:  # noqa: BLE001 - a report must never hold the gate or stop the batch
        print(f"[gate] wait report failed: {error!r}", flush=True)

class Gate:
    """The worker's job slots: up to `slots` requests at a time, with the oldest one's age and the last timeout visible.

    A job whose child survived the kill keeps its slot until that process is gone, so the next job never runs
    next to a runaway one; /health shows it as stuck.

    Window requests take a slot with `hold()` and are refused when window requests hold every slot.
    `active`, `busy`, `busy_seconds` and `stuck` describe window requests only, so /health means for them
    what it always has. Background work (a whole book's encode, one batch at a time) takes a slot with
    `hold_background()`: it waits until no window request runs or waits (see the rules above), and a
    window request that arrives while a batch holds the slot it needs waits for that batch, at most one
    batch, instead of being refused. `background_active` counts the batches."""
    def __init__(self, slots=1, clock=time.monotonic):
        self.slots = max(1, int(slots))
        self._clock = clock
        self._lock = threading.Lock()
        self._changed = threading.Condition(self._lock)
        self._started = {}  # window requests, admitted (running or waiting for a batch) -> admission time
        self._running = set()  # window requests on the device
        self._stuck = set()
        self._background = {}  # background holders -> start time
        self.last_timeout = None
        self._window_admitted = None
        self._window_ended = None
        self._window_refused = None

    @property
    def background_active(self):
        with self._lock:
            return len(self._background)

    def background_seconds(self):
        with self._lock:
            oldest = min(self._background.values(), default=None)
        return round(self._clock() - oldest, 1) if oldest is not None else None

    @property
    def active(self):
        with self._lock:
            return len(self._started)

    @property
    def busy(self):
        """True when window requests take every slot."""
        return self.active >= self.slots

    @property
    def stuck(self):
        with self._lock:
            return bool(self._stuck)

    def busy_seconds(self):
        with self._lock:
            oldest = min(self._started.values(), default=None)
        return round(self._clock() - oldest, 1) if oldest is not None else None

    def _free(self, token):
        with self._lock:
            if self._background.pop(token, None) is None:
                self._started.pop(token, None)
                self._running.discard(token)
                self._stuck.discard(token)
                self._window_ended = self._clock()
            self._changed.notify_all()

    def _background_may_start(self, now):
        if self._started or len(self._background) >= self.slots:
            return False  # a window request runs or waits, or no slot is free
        if self._window_ended is not None and now - self._window_ended < WINDOW_GRACE_S:
            return False
        refused = self._window_refused
        if refused is not None and now - refused < WINDOW_RETRY_S and (
                self._window_admitted is None or self._window_admitted < refused):
            return False  # a refused window request has not come back yet
        return True

    @contextmanager
    def hold_background(self, should_stop=None, poll=0.05, on_wait=None):
        """A slot for one unit of background work, after window requests (see the class). Waits; raises
        GateWaitStopped when `should_stop()` turns true while waiting. `on_wait(True)` is called when the
        holder starts waiting and `on_wait(False)` when the slot is free after a wait (or it stops waiting).
        `on_wait` is never called while this holder has a slot: `on_wait(False)` runs just before the slot
        is taken, and when a window request came in meanwhile the holder reports `True` and waits again. So
        a status write that is slow or never returns delays only this holder, never a window request. A
        report that fails is logged and ignored: it never reaches the holder, and the slot is freed on every
        exit once it was taken."""
        token = object()
        waiting = False  # what the last report said
        taken = False
        try:
            try:
                while True:
                    with self._lock:
                        now = self._clock()
                        free = self._background_may_start(now)
                        if free and not waiting:
                            self._background[token] = now
                            taken = True
                            break
                    if free:
                        waiting = False
                        _report_wait(on_wait, False)  # outside the gate and before the slot is taken
                        continue
                    if should_stop is not None and should_stop():
                        raise GateWaitStopped()
                    if not waiting:
                        waiting = True
                        _report_wait(on_wait, True)
                    time.sleep(poll)
            finally:
                if waiting:
                    _report_wait(on_wait, False)  # stopped while waiting: no slot is held
            yield
        finally:
            if taken:
                self._free(token)

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
                self._window_refused = self._clock()
                raise WorkerBusy()
            self._started[token] = self._window_admitted = self._clock()
            # A book batch on the slot this request needs: wait for it (it starts no new batch meanwhile).
            give_up = time.monotonic() + WINDOW_WAIT_MAX_S
            while self._background and len(self._running) + len(self._background) >= self.slots:
                left = give_up - time.monotonic()
                if left <= 0:
                    del self._started[token]
                    self._window_refused = self._clock()
                    self._changed.notify_all()
                    raise WorkerBusy()
                self._changed.wait(min(left, 0.5))
            self._running.add(token)
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
