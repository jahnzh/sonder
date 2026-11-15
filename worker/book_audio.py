"""Decode a recording's tracks for a whole-book job (#402): on the container's timeline, in parallel.

* Container timeline: ffmpeg's `aresample` filter places the decoded samples by the packets' timestamps
  (`async=1`, dropping or inserting samples where the data and the timestamps differ by more than
  `min_hard_comp`). A plain decode counts samples instead, and drifts where a file's timestamps overlap:
  *The Left Hand of Darkness* (AAC in MP4, 21 chapter joins) decodes to 36,460.25 s by sample count
  against a container duration of 36,458.95 s; with the filter it decodes to 36,458.97 s.
* Per-track check: every decoded track is compared with its container duration (ffprobe); the result
  says per track whether the two agree within DURATION_TOLERANCE_S.
* Parallel decode: a track longer than RANGE_SECONDS is cut into time ranges decoded by separate ffmpeg
  processes (input seeking is by timestamp, so each range starts on the container timeline). Each range
  is cut or padded to its exact sample count, so the joined track has no gap or overlap.
* Bounded writes: the ranges are planned from the probed container duration (never from the request),
  and every ffmpeg process gets a byte cap (`-fs`). A range that reaches its cap fails the decode, so the
  bytes on disk never pass `peak_bytes(plans)`, which the job reserves before decoding. The ranges are
  joined in place (appended to the first and deleted one by one), so a join holds one extra range, not a
  second copy of the track.

Standard library only; the PCM is raw 16 kHz mono s16le, one file per track.
"""
import concurrent.futures
import json
import math
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2
CONTAINER_FILTER = "aresample=async=1:min_hard_comp=0.01:first_pts=0"
DURATION_TOLERANCE_S = 0.25
RANGE_SECONDS = 1800.0
# A range may come back a little short or long at a seek point; more than this is a decode failure.
RANGE_SLACK_S = 1.0
# The last range of a track may decode to this share more than its container duration says (plus
# RANGE_SLACK_S) before it is a failure: the 2026-11-14 recordings differ by at most 0.02 s.
OVER_FRACTION = 0.10
# ffmpeg's -fs stops writing some way past the cap: measured on WSL (ffmpeg 6.1) with WAV, AAC and MP3
# sources and caps from 0.1 to 200 MB, at most 225 KB past it. 1 MiB is allowed per range.
FS_SLACK_BYTES = 1 << 20


class DecodeFailed(Exception):
    pass


class DecodeCancelled(Exception):
    pass


def decode_workers(env=None):
    env = os.environ if env is None else env
    default = max(1, min(8, (os.cpu_count() or 2) - 1))
    try:
        value = int(env.get("ALIGNMENT_BOOK_DECODE_WORKERS", str(default)))
    except (TypeError, ValueError):
        return default
    return value if 1 <= value <= 64 else default


def run_process(command, should_stop=None, poll=0.25):
    """Run a command; kill it when `should_stop()` turns true. Returns (code, stderr text)."""
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)
    try:
        while True:
            try:
                stdout, stderr = process.communicate(timeout=poll)
                return process.returncode, stdout.decode(errors="replace"), stderr.decode(errors="replace")
            except subprocess.TimeoutExpired:
                if should_stop is not None and should_stop():
                    process.kill()
                    process.communicate()
                    raise DecodeCancelled()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def probe_duration(path, ffprobe="ffprobe", should_stop=None):
    """Container duration in seconds (audio stream duration, else format duration), or None."""
    code, out, _ = run_process([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
                                "stream=duration:format=duration", "-of", "json", str(path)], should_stop)
    if code:
        return None
    try:
        data = json.loads(out or "{}")
    except json.JSONDecodeError:
        return None
    for value in [*(s.get("duration") for s in data.get("streams") or []), (data.get("format") or {}).get("duration")]:
        try:
            seconds = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(seconds) and seconds > 0:
            return seconds
    return None


def plan_ranges(duration, range_seconds=RANGE_SECONDS):
    """[(start sample, end sample or None)] for one track. The last range runs to the end of the file."""
    if not duration or duration <= range_seconds:
        return [(0, None)]
    count = math.ceil(duration / range_seconds)
    edges = [round(i * duration / count * SAMPLE_RATE) for i in range(count)]
    return [(edges[i], edges[i + 1] if i + 1 < count else None) for i in range(count)]


def range_cap_bytes(start_sample, end_sample, container_seconds):
    """Most bytes one range may decode to before it counts as a failure."""
    slack = int(RANGE_SLACK_S * SAMPLE_RATE)
    if end_sample is not None:
        samples = end_sample - start_sample + 2 * slack  # fit_range refuses more than `slack` anyway
    else:
        expected = max(0, round(container_seconds * SAMPLE_RATE) - start_sample)
        samples = math.ceil(expected * (1 + OVER_FRACTION)) + slack
    return samples * BYTES_PER_SAMPLE


def plan_tracks(tracks, ffprobe="ffprobe", should_stop=None, range_seconds=RANGE_SECONDS):
    """Probe every track and plan its ranges and byte caps, before anything is written.

    The request's duration is used only when ffprobe cannot read the container's."""
    plans = []
    for track in tracks:
        container = probe_duration(track["audio"], ffprobe, should_stop)
        if container is None and track.get("duration"):
            container = float(track["duration"])
        if container is None:
            raise DecodeFailed(f"The duration of track {track['index']} could not be read.")
        ranges = plan_ranges(container, range_seconds)
        plans.append({"track": track, "container": container, "ranges": ranges,
                      "caps": [range_cap_bytes(start, end, container) for start, end in ranges]})
    return plans


def peak_bytes(plans):
    """The most bytes `decode_tracks(plans)` has on disk at once: every range at its cap, plus one range
    being appended during a join."""
    parts = [cap + FS_SLACK_BYTES for plan in plans for cap in plan["caps"]]
    return sum(parts) + max(parts, default=0)


def decoded_samples_bound(plan):
    """The most samples a planned track decodes to."""
    return sum(plan["caps"]) // BYTES_PER_SAMPLE


def decode_command(source, out, start_sample=0, end_sample=None, ffmpeg="ffmpeg", max_bytes=None):
    command = [ffmpeg, "-nostdin", "-v", "error", "-threads", "1"]
    if start_sample:
        command += ["-ss", f"{start_sample / SAMPLE_RATE:.6f}"]
    if end_sample is not None:
        command += ["-t", f"{(end_sample - start_sample) / SAMPLE_RATE:.6f}"]
    command += ["-i", str(source), "-af", CONTAINER_FILTER, "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le"]
    if max_bytes is not None:
        command += ["-fs", str(int(max_bytes))]
    return command + ["-y", str(out)]


def fit_range(path, samples):
    """Cut or zero-pad a decoded range to exactly `samples` samples. Returns the samples it had."""
    size = path.stat().st_size // BYTES_PER_SAMPLE
    if abs(size - samples) > RANGE_SLACK_S * SAMPLE_RATE:
        raise DecodeFailed(f"A time range decoded to {size / SAMPLE_RATE:.2f} s instead of {samples / SAMPLE_RATE:.2f} s.")
    with path.open("r+b") as handle:
        if size > samples:
            handle.truncate(samples * BYTES_PER_SAMPLE)
        elif size < samples:
            handle.seek(0, os.SEEK_END)
            handle.write(b"\0" * ((samples - size) * BYTES_PER_SAMPLE))
    return size


def duration_check(decoded_seconds, container_seconds, tolerance=DURATION_TOLERANCE_S):
    if container_seconds is None:
        return {"containerSeconds": None, "decodedSeconds": decoded_seconds, "differenceSeconds": None, "ok": None}
    difference = decoded_seconds - container_seconds
    return {"containerSeconds": container_seconds, "decodedSeconds": decoded_seconds,
            "differenceSeconds": difference, "ok": abs(difference) <= tolerance}


def decode_tracks(tracks, folder, workers=None, should_stop=None, on_track=None, ffmpeg="ffmpeg",
                  ffprobe="ffprobe", range_seconds=RANGE_SECONDS, plans=None):
    """Decode `tracks` ([{"index", "audio", "duration"?}]) to `folder/<index>.pcm`.

    `plans` are `plan_tracks(tracks)` when the caller has probed them already (to reserve disk first).
    Ranges of all tracks share one pool of `workers` ffmpeg processes. `on_track(meta)` is called when a
    track is complete. Returns the per-track metadata in track order.
    """
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    workers = workers or decode_workers()
    failed = threading.Event()
    outer_stop = should_stop

    def should_stop():
        return failed.is_set() or (outer_stop is not None and outer_stop())

    started = time.monotonic()
    if plans is None:
        plans = plan_tracks(tracks, ffprobe, should_stop, range_seconds)
    parts = [(t, r) for t, plan in enumerate(plans) for r in range(len(plan["ranges"]))]
    remaining = {t: len(plan["ranges"]) for t, plan in enumerate(plans)}
    results = [None] * len(plans)

    def part_path(t, r):
        return folder / f"{plans[t]['track']['index']}.part{r}.pcm"

    def decode_part(item):
        t, r = item
        plan = plans[t]
        start, end = plan["ranges"][r]
        cap = plan["caps"][r]
        out = part_path(t, r)
        code, _, error = run_process(decode_command(plan["track"]["audio"], out, start, end, ffmpeg, cap), should_stop)
        if code:
            raise DecodeFailed((error or f"ffmpeg exited with {code}").strip()[-500:])
        if out.stat().st_size >= cap:
            raise DecodeFailed(f"Track {plan['track']['index']} decodes to more audio than its container's "
                               f"{plan['container']:.2f} s allow; it was stopped at {cap} bytes.")
        if end is not None:
            fit_range(out, end - start)
        return item

    def finish(t):
        plan = plans[t]
        track = plan["track"]
        target = folder / f"{track['index']}.pcm"
        temporary = folder / f"{track['index']}.join.pcm"
        part_path(t, 0).replace(temporary)
        with temporary.open("ab") as out:
            for r in range(1, len(plan["ranges"])):
                part = part_path(t, r)
                with part.open("rb") as source:
                    shutil.copyfileobj(source, out, 1 << 20)
                part.unlink()  # one range is held twice at most, never the whole track
        temporary.replace(target)
        samples = target.stat().st_size // BYTES_PER_SAMPLE
        meta = {"index": track["index"], "id": track.get("id"), "pcm": target.name, "samples": samples,
                "ranges": len(plan["ranges"]), "method": "container-time",
                "durationCheck": duration_check(samples / SAMPLE_RATE, plan["container"])}
        results[t] = meta
        if on_track is not None:
            on_track(meta)

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(decode_part, item) for item in parts]
            try:
                for future in concurrent.futures.as_completed(futures):
                    t, _ = future.result()
                    remaining[t] -= 1
                    if remaining[t] == 0:
                        finish(t)
            except BaseException:
                failed.set()
                for future in futures:
                    future.cancel()
                raise
    finally:
        for t, plan in enumerate(plans):
            for r in range(len(plan["ranges"])):
                part_path(t, r).unlink(missing_ok=True)
            (folder / f"{plan['track']['index']}.join.pcm").unlink(missing_ok=True)
    return results, time.monotonic() - started
