"""Extract the audio of upcoming sections in parallel while the current one encodes (#346).

Sections are independent, so the server names the next few windows in each /align request. A thread
pool runs one ffmpeg per window ahead of use; align_ctc_section takes the finished WAV instead of
decoding inline. Everything is best effort: a missing, late or failed prefetch falls back to the
inline ffmpeg call, so results never depend on it.
"""
import hashlib
import os
import shutil
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ctc_acoustic import CONTEXT, CORE, SAMPLE_RATE
from ctc_cache import file_version
from deadline import alignment_limit, run_with_deadline

MAX_ENTRIES = 32
STALE_SECONDS = 3600

_LOCK = threading.Lock()
_ENTRIES = OrderedDict()
_POOL = None
_POOL_WORKERS = 0
_SWEPT = set()


def extract_workers(env=None):
    """Parallel ffmpeg processes: many on a GPU host, one where the CPU also runs the encoder (decoding is about 1% of CPU encode time, so overlap gains little there)."""
    env = os.environ if env is None else env
    try:
        value = int(env.get("ALIGNMENT_EXTRACT_WORKERS", ""))
        if 1 <= value <= 16:
            return value
    except (TypeError, ValueError):
        pass
    cpus = os.cpu_count() or 2
    if str(env.get("ALIGNMENT_CTC_DEVICE", "cpu")).startswith("cuda"):
        return min(6, max(1, cpus - 2))
    return 1


def section_window(start, duration):
    """The track-aligned span a section needs: whole cores plus context on both sides."""
    first_sample = round(start * SAMPLE_RATE)
    last_sample = round((start + duration) * SAMPLE_RATE)
    wave_start = max(0, (first_sample // CORE) * CORE - CONTEXT)
    wave_end = ((last_sample + CORE - 1) // CORE) * CORE + CONTEXT
    return wave_start, wave_end


def ffmpeg_command(ffmpeg, audio, wave_start, wave_end, output):
    return [ffmpeg, "-nostdin", "-v", "error", "-threads", "1", "-ss", str(wave_start / SAMPLE_RATE),
            "-i", str(audio), "-t", str((wave_end - wave_start) / SAMPLE_RATE), "-ac", "1",
            "-ar", str(SAMPLE_RATE), "-y", str(output)]


class _Entry:
    def __init__(self, path):
        self.path = path
        self.future = None
        self.abandoned = False


def _folder(media_folder):
    return Path(media_folder) / "ctc-prefetch"


def _sweep(media_folder):
    folder = _folder(media_folder)
    key = str(folder)
    if key in _SWEPT:
        return
    _SWEPT.add(key)
    if not folder.is_dir():
        return
    cutoff = time.time() - STALE_SECONDS
    for item in folder.iterdir():
        try:
            if item.stat().st_mtime < cutoff:
                item.unlink()
        except OSError:
            pass


def _pool(env):
    global _POOL, _POOL_WORKERS
    workers = extract_workers(env)
    if _POOL is None or workers != _POOL_WORKERS:
        if _POOL is not None:
            _POOL.shutdown(wait=False, cancel_futures=True)
        _POOL = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ctc-prefetch")
        _POOL_WORKERS = workers
    return _POOL


def _discard(entry):
    entry.abandoned = True
    if entry.future is None or entry.future.done():
        entry.path.unlink(missing_ok=True)


def _key(audio, start, duration):
    wave_start, wave_end = section_window(start, duration)
    return (str(Path(audio).resolve()), file_version(audio), wave_start, wave_end), wave_start, wave_end


def prefetch(audio, start, duration, media_folder, ffmpeg="ffmpeg", env=None):
    """Queue extraction of one section window. Never raises; returns True when newly queued."""
    env = os.environ if env is None else env
    try:
        key, wave_start, wave_end = _key(audio, start, duration)
        with _LOCK:
            if key in _ENTRIES:
                return False
            _sweep(media_folder)
            _folder(media_folder).mkdir(parents=True, exist_ok=True)
            name = hashlib.sha256(repr(key).encode()).hexdigest()[:24]
            entry = _Entry(_folder(media_folder) / f"{name}.wav")
            _ENTRIES[key] = entry
            while len(_ENTRIES) > MAX_ENTRIES:
                _discard(_ENTRIES.popitem(last=False)[1])
            limit = alignment_limit(duration, env)
            deadline = time.monotonic() + limit
            entry.future = _pool(env).submit(_extract, entry, audio, wave_start, wave_end, deadline, limit, ffmpeg)
        entry.future.add_done_callback(lambda _future, entry=entry: entry.abandoned and entry.path.unlink(missing_ok=True))
        return True
    except Exception:
        return False


def _extract(entry, audio, wave_start, wave_end, deadline, limit, ffmpeg):
    # ffmpeg picks the container from the extension, so the temporary name must still end in .wav.
    temporary = entry.path.with_suffix(".part.wav")
    try:
        code, error = run_with_deadline(ffmpeg_command(ffmpeg, audio, wave_start, wave_end, temporary), deadline, limit)
        if code:
            raise RuntimeError(error or f"ffmpeg exited with {code}")
        if entry.abandoned:
            temporary.unlink(missing_ok=True)
            return
        temporary.replace(entry.path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def take(audio, start, duration, destination, deadline):
    """Move a prefetched window to `destination`. False means the caller must extract inline."""
    try:
        key, _wave_start, _wave_end = _key(audio, start, duration)
    except OSError:
        return False
    with _LOCK:
        entry = _ENTRIES.pop(key, None)
    if entry is None or entry.future is None:
        return False
    try:
        entry.future.result(timeout=max(0.0, deadline - time.monotonic()))
        if not entry.path.is_file():
            return False
        try:
            entry.path.replace(destination)
        except OSError:
            shutil.move(str(entry.path), str(destination))
        return True
    except BaseException:
        _discard(entry)
        return False


def shutdown(wait=False):
    """Drop every entry. `wait` also lets running extractions finish removing their files."""
    global _POOL, _POOL_WORKERS
    with _LOCK:
        for entry in _ENTRIES.values():
            _discard(entry)
        _ENTRIES.clear()
        pool, _POOL, _POOL_WORKERS = _POOL, None, 0
    if pool is not None:
        pool.shutdown(wait=wait, cancel_futures=True)
