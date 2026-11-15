"""The code revision this worker runs, from a file `REVISION` beside its code (#357). The copy that updates a host
writes the commit there (docs/CTC_WORKER_POOL.md); /health reports it as `revision`. A missing, unreadable or empty
file means unknown (None): it never stops the worker."""
import re
from pathlib import Path

REVISION_FILE = Path(__file__).resolve().parent / "REVISION"
# A commit id, a tag or a short description; anything else is cut to these characters.
_ALLOWED = re.compile(r"[^A-Za-z0-9._+/@:-]")
MAX_LENGTH = 64


def read_revision(path=REVISION_FILE):
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return None
    first = text.strip().splitlines()[0] if text.strip() else ""
    value = _ALLOWED.sub("", first.strip())[:MAX_LENGTH]
    return value or None
