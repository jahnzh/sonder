#!/usr/bin/env python3
"""Helpers for scripts/install-ctc-workers.sh that need exact parsing (stdlib only, Python 3.10+).

  env-get FILE KEY            print KEY's value as systemd's EnvironmentFile= sees it; exit 1 when unset
  env-merge FILE OUT          write FILE to OUT keeping every line it does not change: each CTC_SET_<KEY>=V in the
                              environment sets KEY to V, each CTC_DEFAULT_<KEY>=V adds KEY when unset (empty: skip)
  health-idle STATUS BODY     exit 0 when the /health answer proves no request is running, 3 when one is, 4 unknown
  health-check STATUS BODY ENGINE DEVICE REVISION MEDIA_ROOT
                              exit 0 when the answer is one the server accepts for that engine and device, with that
                              revision ("-": not checked) and media root; otherwise print the first difference, exit 1
  auth-body MEDIA_ROOT        read the token on stdin; print an /anchor-batch request that fails after the token check
  unit-names UNIT HOME PATH...
                              print the first PATH the unit file names (itself or below it, %h read as HOME, symlinks
                              resolved); print nothing when it names none

Values go through the environment or stdin, never argv, so the token is not visible in process listings.
"""
import json
import os
import secrets
import sys

NEWLINE = "\n\r"
WHITESPACE = " \t\n\r"
COMMENTS = "#;"
SHELL_NEED_ESCAPE = "\"\\`$"


def valid_name(key):
    # systemd's env_name_is_valid: a non-empty name of letters, digits and underscores, not starting with a digit.
    return bool(key) and not key[0].isdigit() and all(c == "_" or ("a" <= c.lower() <= "z") or c.isdigit() for c in key)


def parse_env(text):
    """Parse like systemd's parse_env_file_internal (src/basic/env-file.c).

    Returns the assignments in order as (key, value, start, end): start and end are character offsets of the
    text the assignment came from. Invalid names are skipped, as systemd skips them. CR counts as a newline, so
    CRLF files give the same values as LF files.
    """
    out = []
    state = "PRE_KEY"
    key = value = ""
    start = 0
    last_key_ws = last_value_ws = None

    def push(end):
        nonlocal key, value
        k = key if last_key_ws is None else key[:last_key_ws]
        if valid_name(k):
            out.append((k, value, start, end))
        key = value = ""

    for i, c in enumerate(text):
        if state == "PRE_KEY":
            if c in COMMENTS:
                state = "COMMENT"
            elif c not in WHITESPACE:
                state, key, start, last_key_ws = "KEY", c, i, None
        elif state == "KEY":
            if c in NEWLINE:
                state, key = "PRE_KEY", ""
            elif c == "=":
                state, value, last_value_ws = "PRE_VALUE", "", None
            else:
                if c not in WHITESPACE:
                    last_key_ws = None
                elif last_key_ws is None:
                    last_key_ws = len(key)
                key += c
        elif state == "PRE_VALUE":
            if c in NEWLINE:
                state = "PRE_KEY"
                push(i)
            elif c == "'":
                state = "SINGLE_QUOTE_VALUE"
            elif c == '"':
                state = "DOUBLE_QUOTE_VALUE"
            elif c == "\\":
                state = "VALUE_ESCAPE"
            elif c not in WHITESPACE:
                state, value = "VALUE", value + c
        elif state == "VALUE":
            if c in NEWLINE:
                state = "PRE_KEY"
                if last_value_ws is not None:
                    value = value[:last_value_ws]
                push(i)
            elif c == "\\":
                state, last_value_ws = "VALUE_ESCAPE", None
            else:
                if c not in WHITESPACE:
                    last_value_ws = None
                elif last_value_ws is None:
                    last_value_ws = len(value)
                value += c
        elif state == "VALUE_ESCAPE":
            state = "VALUE"
            if c not in NEWLINE:
                value += c
        elif state == "SINGLE_QUOTE_VALUE":
            if c == "'":
                state = "PRE_VALUE"
            else:
                value += c
        elif state == "DOUBLE_QUOTE_VALUE":
            if c == '"':
                state = "PRE_VALUE"
            elif c == "\\":
                state = "DOUBLE_QUOTE_VALUE_ESCAPE"
            else:
                value += c
        elif state == "DOUBLE_QUOTE_VALUE_ESCAPE":
            state = "DOUBLE_QUOTE_VALUE"
            if c in SHELL_NEED_ESCAPE:
                value += c
            elif c != "\n":
                value += "\\" + c
        elif state == "COMMENT":
            if c == "\\":
                state = "COMMENT_ESCAPE"
            elif c in NEWLINE:
                state = "PRE_KEY"
        elif state == "COMMENT_ESCAPE":
            state = "PRE_KEY" if c in NEWLINE else "COMMENT"
    if state in ("PRE_VALUE", "VALUE", "VALUE_ESCAPE", "SINGLE_QUOTE_VALUE", "DOUBLE_QUOTE_VALUE",
                 "DOUBLE_QUOTE_VALUE_ESCAPE"):
        if state == "VALUE" and last_value_ws is not None:
            value = value[:last_value_ws]
        push(len(text))
    return out


def effective(assignments):
    values = {}
    for key, value, _start, _end in assignments:
        values[key] = value  # the last assignment wins, as in systemd
    return values


def read_text(path):
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8")
    except FileNotFoundError:
        return None


def quote(value):
    if any(c in value for c in "\n\r"):
        raise ValueError("a value with a line break cannot be written to worker.env")
    if value and all(c.isalnum() or c in "_./:@%+-,=" for c in value):
        return value
    return '"' + "".join("\\" + c if c in SHELL_NEED_ESCAPE else c for c in value) + '"'


def merge(text, set_values, defaults):
    """Return (new text, report lines). Lines of keys this call does not change are kept byte for byte."""
    assignments = parse_env(text)
    current = effective(assignments)
    wanted = {}
    report = []
    for key, value in set_values.items():
        if current.get(key) == value:
            report.append(f"kept {key}")
        else:
            wanted[key] = value
            report.append(f"{'changed' if key in current else 'added'} {key}")
    for key, value in defaults.items():
        if key in set_values:
            continue
        if key in current:
            report.append(f"kept {key}")
        else:
            wanted[key] = value
            report.append(f"added {key}")
    for key in current:
        if key not in set_values and key not in defaults:
            report.append(f"kept {key}")
    if not wanted:
        return text, report
    # Drop every assignment of a key being changed. An assignment can span several physical lines (quotes,
    # continuations); a physical line shared with a kept assignment cannot be edited safely, so the merge refuses.
    # The new assignments go first, as whole lines of their own: every line the merge keeps stays byte for byte,
    # terminator included, even an unterminated last line (appending after it would have to add one).
    line_starts = [0]
    for i, c in enumerate(text):
        if c == "\n":
            line_starts.append(i + 1)

    def lines_of(start, end):
        first = max(i for i, s in enumerate(line_starts) if s <= start)
        last = max(i for i, s in enumerate(line_starts) if s <= max(start, end - 1))
        return set(range(first, last + 1))

    drop = set()
    keep_lines = set()
    for key, _value, start, end in assignments:
        if key in wanted:
            drop |= lines_of(start, end)
        else:
            keep_lines |= lines_of(start, end)
    if drop & keep_lines:
        raise ValueError("worker.env has an assignment this installer changes on the same line as another one; edit it by hand")
    physical = _lines_keepends(text)
    kept = "".join(line for i, line in enumerate(physical) if i not in drop)
    result = "".join(f"{key}={quote(value)}\n" for key, value in wanted.items()) + kept
    # Prove the result: every key ends with the value it had or the value asked for.
    after = effective(parse_env(result))
    expected = dict(current)
    expected.update(wanted)
    if after != expected:
        raise ValueError("internal error: merged worker.env does not parse to the expected values")
    return result, report


def _lines_keepends(text):
    """The physical lines of text, split after each LF only (as line_starts counts them), terminators kept."""
    lines = text.split("\n")
    out = [line + "\n" for line in lines[:-1]]
    if lines[-1]:
        out.append(lines[-1])
    return out


def load_json(path):
    try:
        with open(path, "rb") as handle:
            body = json.loads(handle.read().decode("utf-8"))
    except (OSError, ValueError):
        return None
    return body if isinstance(body, dict) else None


def json_count(value):
    """A JSON integer of at least 0 (not a bool, not a float), else None."""
    return value if type(value) is int and value >= 0 else None


def health_idle(status, path):
    if status != "200":
        return 4, f"/health answered HTTP {status or 'nothing'}"
    body = load_json(path)
    if body is None:
        return 4, "/health did not return a JSON object"
    # Types are checked exactly: JSON 0 and 1 equal False and True in Python, but are not booleans.
    active = json_count(body.get("activeRequests"))
    if active is None:
        return 4, "/health has no valid activeRequests"
    busy, stuck = body.get("busy"), body.get("stuck")
    if type(busy) is not bool or type(stuck) is not bool:
        return 4, "/health has no valid busy and stuck fields"
    # Whole-book work (#402) is reported only under bookJobs (worker/align.py): `jobs` counts the retained book
    # jobs, `slotsHeld` the batches holding a slot, `resuming` is true while retained jobs are picked up. A worker
    # from before #402 has no bookJobs and runs no book work.
    book = "no bookJobs"
    if "bookJobs" in body:
        jobs = body["bookJobs"]
        if not isinstance(jobs, dict):
            return 4, "/health has a bookJobs field that is not an object"
        count, held, resuming = json_count(jobs.get("jobs")), json_count(jobs.get("slotsHeld")), jobs.get("resuming")
        if count is None or held is None or type(resuming) is not bool:
            return 4, "/health has no valid bookJobs jobs, slotsHeld and resuming fields"
        book = f"bookJobs.jobs={count} bookJobs.slotsHeld={held} bookJobs.resuming={str(resuming).lower()}"
        if count > 0 or held > 0 or resuming:
            return 3, f"activeRequests={active} busy={str(busy).lower()} stuck={str(stuck).lower()} {book}"
    if active > 0 or busy or stuck:
        return 3, f"activeRequests={active} busy={str(busy).lower()} stuck={str(stuck).lower()} {book}"
    return 0, f"activeRequests=0, {book}"


def health_check(status, path, engine, device, revision, media_root):
    if status != "200":
        return f"/health answered HTTP {status or 'nothing'}"
    body = load_json(path)
    if body is None:
        return "/health did not return a JSON object"
    # The fields server/alignment-pool.ts (ctcHealthProblem) reads before it gives the worker CTC work.
    ctc = body.get("ctc") if isinstance(body.get("ctc"), dict) else {}
    if body.get("ready") is not True:
        return "the worker is not ready"
    if not isinstance(body.get("mediaRoot"), str) or not os.path.isabs(body["mediaRoot"]):
        return "the worker reports no absolute media root"
    if type(body.get("busy")) is not bool or type(body.get("stuck")) is not bool:
        return "the worker reports no busy/stuck state"
    if ctc.get("engine") != engine:
        return f"the worker runs engine {ctc.get('engine')}, expected {engine}"
    if ctc.get("ready") is not True:
        return "the CTC model is not ready"
    precision = "float16" if device == "cuda" else "float32"
    if ctc.get("device") != device or ctc.get("precision") != precision:
        return f"the worker runs on {ctc.get('device')}/{ctc.get('precision')}, expected {device}/{precision}"
    if revision != "-" and body.get("revision") != revision:
        return f"the worker reports revision {body.get('revision')}, expected {revision}"
    if media_root and body.get("mediaRoot") != os.path.realpath(media_root):
        return f"the worker uses media root {body.get('mediaRoot')}, expected {os.path.realpath(media_root)}"
    return None


def unit_names(unit_file, home, paths):
    """The first of paths that the unit names, as a value of any setting (itself or a path below it)."""
    with open(unit_file, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    words = []
    for line in lines:
        line = line.strip()
        if not line or line[0] in "#;[" or "=" not in line:
            continue
        for word in line.split("=", 1)[1].split():
            word = word.lstrip("-@+!:").replace("%h", home)
            if word.startswith("/"):
                # The word itself, and each of its ancestors with symlinks resolved: a path through `current` or
                # a release's `env` link names what the link points at (a venv's bin/python itself is a link out).
                words.append(word)
                ancestor = word
                while ancestor not in ("/", ""):
                    words.append(os.path.realpath(ancestor))
                    ancestor = os.path.dirname(ancestor)

    def under(word, path):
        return word == path or word.startswith(path.rstrip("/") + "/")

    for path in paths:
        # A path that is itself a symlink is removed as a link, so only its parent is resolved.
        forms = {path, os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))}
        if any(under(word, form) for word in words for form in forms):
            return path
    return None


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    command, args = argv[1], argv[2:]
    if command == "env-get" and len(args) == 2:
        text = read_text(args[0])
        values = effective(parse_env(text)) if text is not None else {}
        if args[1] not in values:
            return 1
        sys.stdout.write(values[args[1]])
        return 0
    if command == "env-merge" and len(args) == 2:
        environ = sorted(os.environ.items())
        set_values = {k[len("CTC_SET_"):]: v for k, v in environ if k.startswith("CTC_SET_") and v}
        defaults = {k[len("CTC_DEFAULT_"):]: v for k, v in environ if k.startswith("CTC_DEFAULT_") and v}
        text = read_text(args[0]) or ""
        try:
            result, report = merge(text, set_values, defaults)
        except ValueError as error:
            print(f"error: {error}", file=sys.stderr)
            return 1
        fd = os.open(args[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(result)
        os.chmod(args[1], 0o600)
        print("\n".join(report))
        return 0
    if command == "health-idle" and len(args) == 2:
        code, reason = health_idle(args[0], args[1])
        print(reason)
        return code
    if command == "health-check" and len(args) == 6:
        problem = health_check(*args)
        if problem:
            print(problem)
            return 1
        return 0
    if command == "auth-body" and len(args) == 1:
        token = sys.stdin.read()
        alignment = os.path.join(args[0], "alignment")
        # A new random name on every run, so the audio cannot exist: /anchor-batch checks the token, then (with a
        # free slot) answers 400 for the missing audio before any work.
        name = ".install-check-" + secrets.token_hex(16)
        print(json.dumps({"token": token, "audio": os.path.join(alignment, name + ".wav"),
                          "output": os.path.join(alignment, name + ".json"), "fragments": ["check"],
                          "windows": [{"start": 0, "duration": 1}], "engine": "ctc"}))
        return 0
    if command == "unit-names" and len(args) >= 2:
        named = unit_names(args[0], args[1], args[2:])
        if named:
            print(named)
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
