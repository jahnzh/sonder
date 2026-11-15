"""Per-book sessions of whole-book jobs (#391, #402, ADR 0016). Standard library only.

A session is keyed by its job and owns everything the worker holds for that book while it is aligned:
the decoded audio and the emissions in the job's folder, the tracks' digests, the emissions handle the
aligner reads, and the process pool that locates and aligns its groups. It ends exactly once:

* when the server has fetched the result,
* when the job is cancelled or fails,
* after IDLE_SECONDS without a request from the server for this job (the server never came back),
* when the worker stops (its resources are released; the folder is kept so the job resumes on restart).

Ending a session stops its pool's processes (SIGTERM, SIGKILL after TERMINATE_GRACE_S, then at most
KILL_WAIT_S more) and drops its handles. Only once every process has exited (and the job's thread, when
the caller says so) is the job's folder deleted (except on worker stop) and its reservation released,
together. A process still there after the bounded wait keeps the session "stuck": folder and reservation
stay, and `SessionRegistry.retry_stuck` releases them once it is gone.

Lock order: (`book_job.Job.end_lock` -> `book_job.BookJobs._lock` ->) `SessionRegistry._lock` -> `BookSession._lock` -> `DiskBudget._lock`. A lock is never taken
while a later one in that order is held. The rule (#402 round 4): a lock that /health, a window request or
the gate can wait on (`SessionRegistry._lock`, `DiskBudget._lock`, `deadline.Gate._lock`) guards memory
only and is never held across file I/O, hashing, a process wait or a sleep. The locks held across such work
are waited on by book work only: `Job.end_lock` (a whole end), `BookJobs._lock` (a start's or the resume's
folder reads and writes; /health and status read `BookJobs._view` instead), `Job.save_lock` (a state.json
write), the pool's stop lock (a bounded terminate and join), and `BookSession._lock`, which `start_pool`
holds while it starts the pool's processes so that a session ending at the same time stops every one.

Disk budget: one budget per worker for every byte under the job folders (ALIGNMENT_BOOK_DISK_BYTES).
A session's reservation is what its folder holds plus the most the next stage adds at its peak; it is
set again before each stage that writes (decode, encode, the book's concatenated emissions) from the
probed durations and the files really on disk, never from the request. Raising a reservation is first
come, first served (DiskBudget); a book that can never fit fails at once. At worker start the files
of retained jobs are claimed before any job runs, so a restart cannot admit more than the disk holds.
"""
import os
import shutil
import threading
import time
from pathlib import Path

IDLE_SECONDS = 15 * 60
# A stopped group-alignment process gets this long to exit after SIGTERM before it is killed, and after
# SIGKILL this long to be gone; one still there then is reported as stuck and keeps its session.
TERMINATE_GRACE_S = 5.0
KILL_WAIT_S = 5.0
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


def emission_bytes(samples):
    """The most bytes one track's emissions take: one 29-label float16 frame per 320 samples."""
    return (int(samples) // 320 + 2) * 29 * 2


def meta_bytes(sentences):
    """State, plan and group files of a book: generous for the 71,225 sentences of the largest. The result
    is not in it: book_job.write_reserved reserves it from its real size before it is written (#403)."""
    return (16 << 20) + 1024 * int(sentences)


def folder_bytes(folder):
    """Bytes of every file under `folder` (0 when it does not exist)."""
    total = 0
    for directory, _dirs, files in os.walk(folder):
        for name in files:
            try:
                total += os.stat(os.path.join(directory, name)).st_size
            except OSError:
                pass
    return total


# How long a pool's release, or a new pool, waits for a pool to read as gone (Session.release_pool, start_pool).
PREVIOUS_POOL_WAIT_S = 2.0


def stop_pool(pool, grace=None, kill_wait=None):
    """Stop a process pool now; True once all of its processes have exited, False if one is still there.

    Pending work is cancelled; running processes get SIGTERM, then SIGKILL after `grace` seconds, and are
    waited for at most `kill_wait` seconds more. Bounded: a process stuck in the kernel (a read from a failing
    disk) does not hold the caller; the answer is then False and the caller keeps what the process may still
    use. Safe to call more than once and from several threads: a later call checks the same processes again."""
    grace = TERMINATE_GRACE_S if grace is None else grace
    kill_wait = KILL_WAIT_S if kill_wait is None else kill_wait
    # Held across the processes' terminate/join, bounded and taken with a timeout; only book ends and job
    # threads stopping their own pool wait on it.
    lock = pool.__dict__.setdefault("_sonder_stop_lock", threading.Lock())
    if not lock.acquire(timeout=grace + kill_wait + 1.0):
        return False  # another thread is stopping it and has not finished in the bounded time
    try:
        processes = pool.__dict__.get("_sonder_processes")
        if processes is None:
            # Taken before shutdown, which forgets them.
            processes = pool.__dict__["_sonder_processes"] = list((getattr(pool, "_processes", None) or {}).values())
            pool.shutdown(wait=False, cancel_futures=True)
            for process in processes:
                try:
                    process.terminate()
                except (OSError, ValueError, AttributeError):
                    pass
            deadline = time.monotonic() + grace
            for process in processes:
                process.join(max(0.0, deadline - time.monotonic()))
            for process in processes:
                if process.is_alive():
                    try:
                        process.kill()
                    except (OSError, ValueError, AttributeError):
                        pass
            deadline = time.monotonic() + kill_wait
            for process in processes:
                process.join(max(0.0, deadline - time.monotonic()))
        else:
            for process in processes:
                if process.is_alive():
                    process.join(0)
        return not any(process.is_alive() for process in processes)
    finally:
        lock.release()


class BudgetExceeded(Exception):
    """The book can never fit: larger than the whole disk budget, or than what is left of it once the
    reservations that are released only after this book (retained jobs still to resume, folders that are
    not jobs, other books waiting before it) are counted."""


class DiskFull(BudgetExceeded):
    """A new job's request does not fit next to the other books now; nothing of it was written."""


class SessionEnded(Exception):
    """The session ended (fetched, cancelled, idle or worker stop) while work was still using it."""


class DiskBudget:
    """One budget for every byte under the job folders.

    `reserve` sets a key's reservation. Lowering one always succeeds. Raising one is first come, first
    served (`wait_turn`): only the oldest waiting key may raise its reservation, so two books that each
    hold part of the budget cannot wait for each other's bytes forever. The oldest waiter gets
    BudgetExceeded when it cannot fit even after every book that is not waiting has released its bytes,
    i.e. when the rest is held by keys that let go only after it (`parked` ones and later waiters)."""

    def __init__(self, total):
        self.total = int(total)
        # Arithmetic on the reservations only, never held across I/O: /health (reserved) waits on it.
        self._lock = threading.Lock()
        self._reserved = {}
        self._waiting = []  # keys waiting to raise their reservation, oldest first
        self._parked = set()  # keys whose bytes are released only after the waiters have run

    def reserve(self, key, nbytes):
        """Reserve `nbytes` for `key`. True when reserved, False when it does not fit now (or an older
        waiter is first). Raises BudgetExceeded when it can never fit."""
        nbytes = int(nbytes)
        if nbytes > self.total:
            raise BudgetExceeded(f"The book needs {nbytes} bytes of disk; the worker's budget is {self.total}.")
        with self._lock:
            if nbytes <= self._reserved.get(key, 0):
                self._reserved[key] = nbytes  # lowering never waits
                return True
            if self._waiting and self._waiting[0] != key and key in self._waiting:
                return False  # an older book is first
            held = sum(v for k, v in self._reserved.items()
                       if k != key and (k in self._parked or (k in self._waiting and k != key)))
            if held + nbytes > self.total:
                raise BudgetExceeded(
                    f"The book needs {nbytes} bytes of disk, and {held} of the worker's {self.total} are held "
                    "by book jobs that can release them only after this one (retained jobs waiting to resume, "
                    "other books waiting for disk, folders that are not jobs). It can never fit.")
            used = sum(v for k, v in self._reserved.items() if k != key)
            if used + nbytes > self.total:
                return False
            self._reserved[key] = nbytes
            return True

    def fits_now(self, key, nbytes):
        """Reserve `nbytes` for a key that has nothing yet only if it fits at once (a new job's request)."""
        nbytes = int(nbytes)
        with self._lock:
            used = sum(v for k, v in self._reserved.items() if k != key)
            if used + nbytes > self.total:
                raise DiskFull(f"The worker's book-job disk budget is full: {used} of {self.total} bytes are "
                               f"reserved and this request needs {nbytes}. Retry when another book job has ended.")
            self._reserved[key] = nbytes

    def claim(self, key, nbytes):
        """Record bytes that are already on disk (retained at a restart), whether or not they fit."""
        with self._lock:
            self._reserved[key] = int(nbytes)

    def wait_turn(self, key):
        with self._lock:
            if key not in self._waiting:
                self._waiting.append(key)

    def leave_turn(self, key):
        with self._lock:
            if key in self._waiting:
                self._waiting.remove(key)

    def park(self, key):
        with self._lock:
            self._parked.add(key)

    def unpark(self, key):
        with self._lock:
            self._parked.discard(key)

    def release(self, key):
        with self._lock:
            self._parked.discard(key)
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
        # The session's attributes. Held across I/O nowhere; start_pool holds it while the pool's processes
        # are started (not waited for). Book requests (touch) and the job thread wait on it, /health does not.
        self._lock = threading.Lock()
        self.last_used = clock()
        self.ended = None  # reason once ended
        self.ended_at = None
        self._delete = False  # what the end does with the folder once nothing runs any more
        self._keep = 0  # bytes the end keeps reserved on top of what is left (a failed job's error record)
        self._busy = None
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
        """Reserve the book's disk estimate, waiting (in turn, oldest first) while other sessions hold the
        budget. Raises BudgetExceeded when the book can never fit (see DiskBudget)."""
        self.budget.wait_turn(self.key)
        try:
            while True:
                self.check()
                if self.budget.reserve(self.key, nbytes):
                    return
                if should_wait is not None and not should_wait():
                    raise SessionEnded("cancelled")
                time.sleep(poll)
        finally:
            self.budget.leave_turn(self.key)

    def claim_disk(self, nbytes):
        """The files this session's folder already holds, counted before anything else is admitted."""
        self.budget.claim(self.key, nbytes)

    def set_pool(self, pool):
        with self._lock:
            if self.ended is not None:
                ended = self.ended
            else:
                self.pool = pool
                return
        stop_pool(pool)
        raise SessionEnded(ended)

    def start_pool(self, pool, submit):
        """Hand `pool` to the session and run `submit(pool)` (which starts its processes) under the session's
        lock, so an end at the same moment sees every process. Returns what `submit` returns."""
        previous = self.pool  # read without the lock; checked again under it below
        if previous is not None and previous is not pool:
            # The job's earlier pool (#403: the groups' before the leftover pass's), released a moment ago, can
            # read as running while the executor's own thread is still reaping its processes: look again, for
            # a bounded time, holding no lock.
            deadline = time.monotonic() + PREVIOUS_POOL_WAIT_S
            gone = stop_pool(previous)
            while not gone and time.monotonic() < deadline:
                time.sleep(0.05)
                gone = stop_pool(previous)
            if gone:
                with self._lock:
                    if self.pool is previous:
                        self.pool = None
        with self._lock:
            # One pool at a time (#403: the leftover pass starts its own after the groups'): a pool whose
            # processes did not exit stays the session's, so its end still sees them.
            busy = self.pool is not None and self.pool is not pool
            if self.ended is None and not busy:
                self.pool = pool
                return submit(pool)
            ended = self.ended
        stop_pool(pool)
        if ended is None:
            raise RuntimeError("An earlier process pool of this job is still running.")
        raise SessionEnded(ended)

    def release_pool(self, pool, stop=True):
        """The job is done with its pool: its processes are stopped (bounded, see stop_pool). The session
        lets go of the pool only once they have exited; otherwise it keeps it, so an end of the session sees
        the processes and keeps the folder and the reservation while one is still there. True when gone."""
        gone = stop_pool(pool)
        # A process the executor's own thread is still reaping can read as running for a moment (#403):
        # look again for a bounded time, holding no lock, before keeping the pool as still running.
        deadline = time.monotonic() + PREVIOUS_POOL_WAIT_S
        while not gone and time.monotonic() < deadline:
            time.sleep(0.05)
            gone = stop_pool(pool)
        if gone:
            with self._lock:
                if self.pool is pool:
                    self.pool = None
        return gone

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

    def _end(self, reason, delete, busy=None, keep=0):
        """End the session (once). Returns False when it had already ended, "stuck" when a group process
        (or `busy()`, the job's thread) is still there, so the folder and the reservation are kept, or when
        files of the folder could not be deleted, and True when it is released. `delete` removes the job's
        whole folder; False keeps it (worker stop). `keep` bytes stay reserved (see finish_end)."""
        with self._lock:
            if self.ended is not None:
                return False
            self.ended = reason
            self.ended_at = time.time()
            closers, self._closers = self._closers, []
            self.emissions = None
            self.decoded = {}
        for closer in closers:
            try:
                closer(reason)
            except Exception:
                pass
        self._delete = delete
        self._busy = busy
        self._keep = int(keep)
        return True if self.finish_end() else "stuck"

    def finish_end(self):
        """Delete and release once nothing of the job runs any more; False (and nothing done) until then.

        The reservation shrinks only by the bytes really removed: what is left after the delete (a file that
        failed to delete) stays reserved, and False keeps the session stuck so a later call retries. `keep`
        bytes (a failed job's error record, about to be written) are reserved before the rest is released."""
        with self._lock:
            pool = self.pool
        if pool is not None and not stop_pool(pool):
            return False
        busy = self._busy
        if busy is not None and busy():
            return False
        with self._lock:
            if self.pool is pool:
                self.pool = None
        left = 0
        if self._delete:
            shutil.rmtree(self.folder, ignore_errors=True)
            left = folder_bytes(self.folder)
        if left or self._keep:
            self.budget.claim(self.key, left + self._keep)
        else:
            self.budget.release(self.key)
        return not left


class SessionRegistry:
    """The worker's book sessions, by job key."""

    def __init__(self, budget=None, idle=None, clock=time.monotonic):
        self.budget = budget if budget is not None else DiskBudget(disk_budget_bytes())
        self.idle = idle if idle is not None else idle_seconds()
        self._clock = clock
        # The dicts only: never held across I/O or while another lock is waited for. /health (stuck) waits on it.
        self._lock = threading.Lock()
        self._sessions = {}
        self._stuck = {}  # key -> session that ended while one of its processes was still there
        self._ending = {}  # key -> _Ending of the end in progress (one end per session at a time)

    def open(self, key, folder):
        with self._lock:
            session = self._sessions.get(key)
            if session is None or session.ended is not None:
                session = BookSession(key, folder, self.budget, self._clock)
                self._sessions[key] = session
        session.touch()  # outside _lock: /health waits on _lock, and start_pool holds the session's lock
        return session

    def get(self, key):
        with self._lock:
            return self._sessions.get(key)

    def keys(self):
        with self._lock:
            return list(self._sessions)

    def end(self, key, reason, delete=True, busy=None, keep=0):
        """End one session (idempotent). Returns True when it ended and was released, "stuck" when it
        ended but keeps its folder and reservation until its processes are gone (`retry_stuck`), and
        False when there was no session. One end at a time: a call while another end of the same session
        is still stopping its processes waits for that end and returns its outcome, so no caller takes a
        session that is being stopped for one that has none (and deletes its folder)."""
        with self._lock:
            ending = self._ending.get(key)
            if ending is None:
                if key in self._stuck:
                    return "stuck"
                session = self._sessions.pop(key, None)
                if session is None:
                    return False
                ending = self._ending[key] = _Ending()
            else:
                session = None
        if session is None:
            ending.done.wait()
            return ending.outcome
        return self._finish(key, session, ending, reason, delete, busy, keep)

    def _finish(self, key, session, ending, reason, delete, busy, keep):
        outcome = "stuck"  # kept if the end itself raises: nothing is deleted or released then
        try:
            outcome = session._end(reason, delete, busy, keep)
        finally:
            with self._lock:
                if outcome == "stuck":
                    self._stuck[key] = session
                self._ending.pop(key, None)
                ending.outcome = outcome
            ending.done.set()
        return outcome

    def is_stuck(self, key):
        with self._lock:
            return key in self._stuck

    def retry_stuck(self):
        """Release the stuck sessions whose processes have exited since. Returns the keys released."""
        with self._lock:
            stuck = list(self._stuck.items())
        released = []
        for key, session in stuck:
            if session.finish_end():
                with self._lock:
                    self._stuck.pop(key, None)
                released.append(key)
        return released

    def stuck(self):
        """/health's view of the sessions kept because a process is still there or files are left."""
        with self._lock:
            stuck = list(self._stuck.items())
        return [{"jobId": key, "reason": session.ended, "since": session.ended_at,
                 "reservedBytes": self.budget.reserved(key)} for key, session in stuck]

    def idle_keys(self):
        with self._lock:
            sessions = list(self._sessions.items())
        return [key for key, session in sessions if session.idle_for() >= self.idle]

    def close_all(self, reason="worker stop", busy=None):
        """Worker stop: release everything held in memory but keep the folders, so jobs resume. `busy`
        maps a key to its job thread's liveness: a session whose thread still runs keeps its reservation
        and is reported stuck, as on every other end."""
        busy = busy or {}
        for key in self.keys():
            self.end(key, reason, delete=False, busy=busy.get(key))


class _Ending:
    """One end in progress; later callers wait for it and get its outcome."""

    def __init__(self):
        self.done = threading.Event()
        self.outcome = "stuck"
