"""Bounded, recording-level LRU storage for completed CTC emission chunks."""
import fcntl
import hashlib
import json
import os
import shutil
import struct
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from ctc_acoustic import CORE, RECEPTIVE_FIELD, STRIDE

DEFAULT_BUDGET = 5 * 1024 ** 3


def budget_bytes(env=os.environ):
    try:
        value = int(env.get("ALIGNMENT_CTC_CACHE_BYTES", ""))
    except (ValueError, TypeError):
        return DEFAULT_BUDGET
    return value if 0 <= value <= 1024 ** 4 else DEFAULT_BUDGET


def file_version(path):
    stat = Path(path).stat()
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


# One whole-file hash per file version: the version holds the inode, size, mtime and ctime, and ctime
# cannot be restored by resetting mtime. Like git's racy-timestamp rule, only a file whose ctime is clearly
# older than the hash is remembered: a file written within the timestamp tick of an earlier version can
# share its version, so it is always hashed again.
_DIGESTS = {}
_DIGEST_LOCK = threading.Lock()
_DIGEST_LIMIT = 64
_QUIET_NS = 2_000_000_000


def audio_digest(path):
    """Hash the audio bytes, including replacements that preserve file timestamps."""
    path = Path(path)
    before = file_version(path)
    with _DIGEST_LOCK:
        remembered = _DIGESTS.get((str(path), before))
    if remembered:
        return remembered, before
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(block)
    if file_version(path) != before:
        raise ValueError("Audio changed while computing its cache identity.")
    digest = hasher.hexdigest()
    if time.time_ns() - before[4] > _QUIET_NS:
        with _DIGEST_LOCK:
            if len(_DIGESTS) >= _DIGEST_LIMIT:
                _DIGESTS.pop(next(iter(_DIGESTS)))
            _DIGESTS[(str(path), before)] = digest
    return digest, before


# Sizes of the cache's recording directories, kept per cache root so a write does not stat every file
# (a full scan of a few GB of chunks took about a second, under the exclusive lock, on every write).
# Each process rescans at most every _RESCAN_SECONDS, which also picks up other processes' writes.
_RESCAN_SECONDS = 60.0
_INDEXES = {}


def _key(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


class AcousticCache:
    def __init__(self, folder, recording, engine, audio_version, track, budget):
        self.root = Path(folder) / "ctc-acoustic-v1"
        self.root.mkdir(parents=True, exist_ok=True)
        self.recording = _key([recording, audio_version, engine])
        self.track = _key(track)
        self.budget = budget
        with self._locked():
            # Its own leftovers go at once; other directories' on the next rescan.
            for path in (self.root / self.recording).glob("*.tmp"):
                path.unlink(missing_ok=True)
            self._evict(0)

    @contextmanager
    def _locked(self):
        with (self.root / ".lock").open("a+b") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def _directories(self):
        return [p for p in self.root.iterdir() if p.is_dir() and not p.is_symlink()]

    def _clean_temporaries(self):
        for directory in self._directories():
            for path in directory.glob("*.tmp"):
                path.unlink(missing_ok=True)

    def _usage(self, directory):
        return sum(p.stat().st_size for p in directory.iterdir() if p.is_file() and not p.is_symlink())

    def _sizes(self):
        """Directory name -> bytes, rescanned (with leftover temporaries removed) once it is older than
        _RESCAN_SECONDS. Call with the lock held."""
        index = _INDEXES.get(str(self.root))
        if index is None or time.monotonic() - index["scanned"] > _RESCAN_SECONDS:
            self._clean_temporaries()
            index = {"scanned": time.monotonic(), "sizes": {p.name: self._usage(p) for p in self._directories()}}
            _INDEXES[str(self.root)] = index
        return index["sizes"]

    def _evict(self, incoming, protect=None):
        directories = self._directories()
        known = self._sizes()
        for directory in directories:
            if directory.name not in known:
                known[directory.name] = self._usage(directory)
        for name in [name for name in known if name not in {p.name for p in directories}]:
            del known[name]
        sizes = {p: known[p.name] for p in directories}
        total = sum(sizes.values())
        for directory in sorted(directories, key=lambda p: (p.stat().st_mtime_ns, p.name)):
            if total + incoming <= self.budget:
                break
            if directory.name == protect:
                continue
            shutil.rmtree(directory)
            known.pop(directory.name, None)
            total -= sizes[directory]
        return total + incoming <= self.budget

    def _path(self, index):
        return self.root / self.recording / f"{self.track}-{index}.complete"

    def read(self, index, classes):
        with self._locked():
            path = self._path(index)
            try:
                with path.open("rb") as handle:
                    size = handle.read(4)
                    if len(size) != 4:
                        raise ValueError("short header")
                    length = struct.unpack("<I", size)[0]
                    if not 0 < length <= 4096:
                        raise ValueError("invalid header")
                    header = json.loads(handle.read(length))
                    data = handle.read()
                frames = header["frames"]
                first = header["first"]
                if (type(frames) is not int or not 0 < frames <= CORE // STRIDE or
                    type(first) is not int or first != index * CORE + (RECEPTIVE_FIELD - STRIDE) // 2 or
                    header["classes"] != classes or len(data) != frames * classes * 4 or
                    hashlib.sha256(data).hexdigest() != header["sha256"]):
                    raise ValueError("invalid chunk")
            except FileNotFoundError:
                return None
            except (ValueError, KeyError, TypeError, UnicodeError, json.JSONDecodeError):
                path.unlink(missing_ok=True)
                return None
            os.utime(path.parent, None)
            return first, frames, data

    def write(self, index, first, frames, classes, data):
        if frames <= 0 or classes <= 0 or len(data) != frames * classes * 4:
            raise ValueError("Invalid float32 emission chunk.")
        header = json.dumps({"first": first, "frames": frames, "classes": classes,
                             "sha256": hashlib.sha256(data).hexdigest()}, separators=(",", ":")).encode()
        content = struct.pack("<I", len(header)) + header + data
        with self._locked():
            path = self._path(index)
            if path.exists():
                return True
            if not self._evict(len(content), protect=self.recording):
                return False
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.parent / f"{uuid.uuid4().hex}.tmp"
            try:
                with temporary.open("xb") as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
                # The complete file is itself the atomic completion marker.
                os.replace(temporary, path)
                sizes = self._sizes()
                sizes[self.recording] = sizes.get(self.recording, 0) + len(content)
                os.utime(path.parent, None)
            finally:
                temporary.unlink(missing_ok=True)
            return True
