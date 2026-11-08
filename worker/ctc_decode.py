"""Decode each track once to 16 kHz mono PCM and slice sample windows from it."""
import os
import threading
import wave
from pathlib import Path

from ctc_acoustic import SAMPLE_RATE
from ctc_cache import file_version
from deadline import AlignmentFailed, run_with_deadline

# Remember decoded paths by source version; PCM stays on disk under MEDIA_ROOT.
_LOCK = threading.Lock()
_CACHE = {}
_CACHE_LIMIT = 8
DEFAULT_DECODED_BUDGET = 6 * 1024 ** 3


class DecodedTrack:
    """On-disk 16 kHz mono PCM with random-access window reads (no whole-book float32)."""

    def __init__(self, path, version):
        self.path = Path(path)
        self.version = version
        with wave.open(str(self.path), "rb") as audio_file:
            if (audio_file.getnchannels(), audio_file.getsampwidth(), audio_file.getframerate()) != (1, 2, SAMPLE_RATE):
                raise ValueError("Expected mono 16-bit PCM at 16 kHz.")
            self.nframes = audio_file.getnframes()

    def __len__(self):
        return self.nframes

    def slice(self, start_sample, end_sample):
        import numpy as np
        start_sample = max(0, int(start_sample))
        end_sample = min(self.nframes, int(end_sample))
        if end_sample <= start_sample:
            raise ValueError("Audio is too short for the requested window.")
        with wave.open(str(self.path), "rb") as audio_file:
            audio_file.setpos(start_sample)
            raw = audio_file.readframes(end_sample - start_sample)
        return np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0


def decoded_dir(media_folder):
    path = Path(media_folder) / "decoded"
    path.mkdir(parents=True, exist_ok=True)
    return path


def decoded_path(media_folder, version):
    key = f"{version[0]}-{version[1]}-{version[2]}-{version[3]}"
    return decoded_dir(media_folder) / f"{key}.wav"


def decoded_budget_bytes(env=None):
    env = os.environ if env is None else env
    try:
        value = int(env.get("ALIGNMENT_CTC_DECODED_MAX_BYTES", str(DEFAULT_DECODED_BUDGET)))
    except (TypeError, ValueError):
        return DEFAULT_DECODED_BUDGET
    return value if 0 <= value <= 1024 ** 4 else DEFAULT_DECODED_BUDGET


def _in_use_paths():
    return {Path(track.path).resolve() for track in _CACHE.values()}


def _touch(path):
    try:
        os.utime(path, None)
    except OSError:
        pass


def evict_decoded(media_folder, env=None, protect=None):
    """Drop least-recently-used decoded WAVs until the directory is under the byte cap.

    Files currently referenced by the in-memory cache (and any explicit ``protect``
    paths) are never removed. Safe to call at worker start and after each decode.
    """
    budget = decoded_budget_bytes(env)
    folder = decoded_dir(media_folder)
    protected = {Path(path).resolve() for path in (protect or ())}
    protected |= _in_use_paths()
    with _LOCK:
        files = [path for path in folder.glob("*.wav") if path.is_file()]
        sizes = {}
        order = []
        for path in files:
            try:
                stat = path.stat()
            except OSError:
                continue
            sizes[path] = stat.st_size
            order.append((stat.st_mtime_ns, path.name, path))
        total = sum(sizes.values())
        if total <= budget:
            return total
        for _mtime, _name, path in sorted(order):
            if total <= budget:
                break
            if path.resolve() in protected:
                continue
            try:
                path.unlink()
            except OSError:
                continue
            total -= sizes.pop(path, 0)
            for key, track in list(_CACHE.items()):
                if Path(track.path).resolve() == path.resolve():
                    _CACHE.pop(key, None)
        return total


def forget_decoded(track, media_folder=None, env=None):
    """Delete one decoded WAV after the job that needed PCM is finished.

    Acoustic cores already live in the acoustic cache; pooled jobs stage a fresh
    audio copy next time, so keeping the multi-GB PCM forever only wastes disk.
    """
    raw = getattr(track, "path", None)
    if raw is None:
        return
    try:
        path = Path(raw)
    except TypeError:
        return
    with _LOCK:
        for key, remembered in list(_CACHE.items()):
            try:
                if Path(remembered.path).resolve() == path.resolve():
                    _CACHE.pop(key, None)
            except (TypeError, OSError):
                continue
        path.unlink(missing_ok=True)
    if media_folder is not None:
        evict_decoded(media_folder, env=env)


def ensure_decoded(audio, media_folder, deadline, limit, ffmpeg="ffmpeg", env=None):
    """Return (DecodedTrack, source_version, extraction_seconds, cache_hit)."""
    import time
    env = os.environ if env is None else env
    audio = Path(audio)
    version = file_version(audio)
    cache_key = (str(audio.resolve()), version)
    started = time.monotonic()
    with _LOCK:
        remembered = _CACHE.get(cache_key)
        if remembered is not None and remembered.path.is_file():
            _touch(remembered.path)
            return remembered, version, 0.0, True
        wave_path = decoded_path(media_folder, version)
        if wave_path.is_file() and file_version(wave_path)[2] > 44:
            _touch(wave_path)
            track = DecodedTrack(wave_path, version)
            _remember(cache_key, track)
            return track, version, time.monotonic() - started, True
    temporary = wave_path.with_suffix(".part.wav")
    try:
        code, error = run_with_deadline(
            [ffmpeg, "-nostdin", "-v", "error", "-threads", "1", "-i", str(audio),
             "-ac", "1", "-ar", str(SAMPLE_RATE), "-y", str(temporary)],
            deadline, limit)
        if code:
            raise AlignmentFailed(error or f"ffmpeg exited with {code}")
        if file_version(audio) != version:
            raise ValueError("Audio changed during full-track decode.")
        temporary.replace(wave_path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    track = DecodedTrack(wave_path, version)
    with _LOCK:
        _remember(cache_key, track)
    evict_decoded(media_folder, env=env, protect={wave_path.resolve()})
    return track, version, time.monotonic() - started, False


def _remember(key, track):
    if key in _CACHE:
        _CACHE.pop(key, None)
    while len(_CACHE) >= _CACHE_LIMIT:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = track


def clear_decoded_cache():
    with _LOCK:
        _CACHE.clear()
