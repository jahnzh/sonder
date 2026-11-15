"""Stand-ins for book_align.pool_align that run in the group-alignment processes of test_book_pipeline.

They live in their own module so a spawned process can import them by name. Standard library only."""
import os
import signal
import time
from pathlib import Path


def sleep_ignoring_term(task):
    """A group that never ends and ignores SIGTERM: only SIGKILL stops it. Writes its pid first."""
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    Path(os.environ["BOOK_TEST_PID_DIR"], str(os.getpid())).write_text(str(task["index"]))
    time.sleep(600)


def echo_piece(task):
    """A leftover piece that maps its own index after a delay that reverses the finishing order."""
    time.sleep(0.4 * (2 - task["index"]))
    return {task["index"]: (10 * task["index"], 10 * task["index"] + 5)}
