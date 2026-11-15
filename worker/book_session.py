"""Per-book sessions of whole-book jobs (#391, #402, ADR 0016). Standard library only.

A session is keyed by its job and owns everything the worker holds for that book while it is aligned:
the decoded audio and the emissions in the job's folder, the tracks' digests, the emissions handle the
aligner reads, and the process pool that locates and aligns its groups. It ends exactly once:

* when the server has fetched the result,
* when the job is cancelled,
* after IDLE_SECONDS without a request from the server for this job (the server never came back),
* when the worker stops (its resources are released; the folder is kept so the job resumes on restart).

Ending a session closes its pool, drops its handles and releases its disk reservation; except on worker
stop it also deletes the decoded audio and the emissions.

Lock order: `SessionRegistry._lock` -> `BookSession._lock` -> `DiskBudget._lock`. A lock is never taken
while a later one in that order is held, and none is held while waiting for the encode queue, for a
process or for disk I/O on book data.

Disk budget: one budget per worker for decoded audio and emissions together (ALIGNMENT_BOOK_DISK_BYTES).
A session reserves its book's estimate before it decodes; a book that does not fit next to the other
sessions waits, and a book larger than the whole budget fails at once.
"""
import os
import shutil
import threading
import time
from pathlib import Path

IDLE_SECONDS = 15 * 60
DEFAULT_DISK_BYTES = 64 * 1024 ** 3
PCM_BYTES_PER_SECOND = 16000 * 2
# Per-track emissions plus the book's concatenated copy for the aligner: 50 frames x 29 labels x 2 bytes, twice.
EMISSION_BYTES_PER_SECOND = 50 * 29 * 2 * 2


def disk_budget_bytes(env=None):
    env = os.environ if env is None else env
    try:
        value = int(env.get("ALIGNMENT_BOOK_DISK_BYTES", str(DEFAULT_DISK_BYTES)))
    except (TypeError, ValueError):
        return DEFAULT_DISK_BYTES
    return value if 0 < value <= 1024 ** 5 else DEFAULT_DISK_BYTES


def idle_seconds(env=None):
    env = os.environ if env is None else env
    try:
        value = float(env.get("ALIGNMENT_BOOK_IDLE_SECONDS", str(IDLE_SECONDS)))
    except (TypeError, ValueError):
        return float(IDLE_SECONDS)
    return value if value > 0 else float(IDLE_SECONDS)


def estimate_bytes(audio_seconds):
    """Peak disk of one book: all decoded PCM plus its emissions (+5 % for decoder slack)."""
    return int(audio_seconds * (PCM_BYTES_PER_SECOND + EMISSION_BYTES_PER_SECOND) * 1.05) + (1 << 20)


class BudgetExceeded(Exception):
    """The book alone needs more than the whole disk budget."""


class SessionEnded(Exception):
    """The session ended (fetched, cancelled, idle or worker stop) while work was still using it."""


class DiskBudget:
    def __init__(self, total):
        self.total = int(total)
        self._lock = threading.Lock()
        self._reserved = {}

    def reserve(self, key, nbytes):
        """Reserve `nbytes` for `key`. True when reserved, False when it does not fit now."""
        nbytes = int(nbytes)
        if nbytes > self.total:
            raise BudgetExceeded(f"The book needs {nbytes} bytes of decoded audio and emissions; "
                                 f"the worker's budget is {self.total}.")
        with self._lock:
            used = sum(v for k, v in self._reserved.items() if k != key)
            if used + nbytes > self.total:
                return False
            self._reserved[key] = nbytes
            return True

    def release(self, key):
        with self._lock:
            return self._reserved.pop(key, 0)

    def reserved(self, key=None):
        with self._lock:
            return self._reserved.get(key, 0) if key is not None else sum(self._reserved.values())


class BookSession:
    """Resources of one book's job. Use `registry.open()` to create one."""

    def __init__(self, key, folder, budget, clock=time.monotonic):
        self.key = key
        self.folder = Path(folder)
        self.budget = budget
        self._clock = clock
        self._lock = threading.Lock()
        self.last_used = clock()
        self.ended = None  # reason once ended
        self.digests = {}  # track index -> sha256 of the source audio
        self.decoded = {}  # track index -> PCM path
        self.emissions = None  # handle the aligner reads (numpy memmap), dropped on end
        self.pool = None  # process pool for locate and group alignment
        self._closers = []

    def touch(self):
        with self._lock:
            self.last_used = self._clock()

    def idle_for(self):
        with self._lock:
            return self._clock() - self.last_used

    def check(self):
        """Raise SessionEnded when the session has ended; long-running stages call this between steps."""
        if self.ended is not None:
            raise SessionEnded(self.ended)

    def reserve_disk(self, nbytes, should_wait=None, poll=1.0):
        """Reserve the book's disk estimate, waiting while other sessions hold the budget."""
        while True:
            self.check()
            if self.budget.reserve(self.key, nbytes):
                return
            if should_wait is not None and not should_wait():
                raise SessionEnded("cancelled")
            time.sleep(poll)

    def set_pool(self, pool):
        with self._lock:
            if self.ended is not None:
                pool.shutdown(wait=False, cancel_futures=True)
                raise SessionEnded(self.ended)
            self.pool = pool

    def add_decoded(self, index, path, digest=None):
        with self._lock:
            self.decoded[index] = Path(path)
            if digest:
                self.digests[index] = digest

    def drop_decoded(self, index):
        """Delete one track's PCM once its emissions are complete (the aligner never reads PCM)."""
        with self._lock:
            path = self.decoded.pop(index, None)
        if path is not None:
            path.unlink(missing_ok=True)

    def on_end(self, closer):
        """Run `closer(reason)` when the session ends (for handles a stage opened)."""
        with self._lock:
            self._closers.append(closer)

    def _end(self, reason, delete):
        with self._lock:
            if self.ended is not None:
                return False
            self.ended = reason
            pool, self.pool = self.pool, None
            closers, self._closers = self._closers, []
            self.emissions = None
            decoded, self.decoded = self.decoded, {}
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
        for closer in closers:
            try:
                closer(reason)
            except Exception:
                pass
        if delete:
            for path in decoded.values():
                Path(path).unlink(missing_ok=True)
            for name in ("tracks", "emissions"):
                shutil.rmtree(self.folder / name, ignore_errors=True)
        self.budget.release(self.key)
        return True


class SessionRegistry:
    """The worker's book sessions, by job key."""

    def __init__(self, budget=None, idle=None, clock=time.monotonic):
        self.budget = budget if budget is not None else DiskBudget(disk_budget_bytes())
        self.idle = idle if idle is not None else idle_seconds()
        self._clock = clock
        self._lock = threading.Lock()
        self._sessions = {}

    def open(self, key, folder):
        with self._lock:
            session = self._sessions.get(key)
            if session is None or session.ended is not None:
                session = BookSession(key, folder, self.budget, self._clock)
                self._sessions[key] = session
            session.touch()
            return session

    def get(self, key):
        with self._lock:
            return self._sessions.get(key)

    def keys(self):
        with self._lock:
            return list(self._sessions)

    def end(self, key, reason, delete=True):
        """End one session (idempotent). Returns True when this call ended it."""
        with self._lock:
            session = self._sessions.pop(key, None)
        return session._end(reason, delete) if session is not None else False

    def idle_keys(self):
        with self._lock:
            sessions = list(self._sessions.items())
        return [key for key, session in sessions if session.idle_for() >= self.idle]

    def close_all(self, reason="worker stop"):
        """Worker stop: release everything held in memory but keep the folders, so jobs resume."""
        with self._lock:
            sessions, self._sessions = list(self._sessions.values()), {}
        for session in sessions:
            session._end(reason, delete=False)
