"""Child process for one alignment step: `python align_task.py <spec.json> <result.json>`.
The parent kills this process (and anything it started) when the deadline passes."""
import json
import resource
import sys
from pathlib import Path

LANGUAGES = {"eng", "fra", "deu", "spa", "ita", "por", "nob", "dan", "swe", "nld"}

def align(spec):
    from aeneas.task import Task
    from aeneas.executetask import ExecuteTask
    language = spec["language"] if spec["language"] in LANGUAGES else "eng"
    task = Task(config_string=f"task_language={language}|is_text_type=plain|os_task_file_format=json|task_adjust_boundary_algorithm=percent|task_adjust_boundary_percent_value=50")
    task.audio_file_path_absolute = spec["wave"]
    task.text_file_path_absolute = spec["text"]
    task.sync_map_file_path_absolute = spec["map"]
    ExecuteTask(task).execute()
    task.output_sync_map_file()
    raw = json.loads(Path(spec["map"]).read_text())
    intervals = [{"index": i, "start": float(fragment["begin"]) + spec["start"], "end": float(fragment["end"]) + spec["start"]} for i, fragment in enumerate(raw["fragments"])]
    quality = None
    # A short independent excerpt catches gross edition mismatches. The full text
    # still goes straight to the aligner; this never transcribes the chapter.
    if (Path(spec["folder"]) / "models" / "whisper").exists():
        from anchors import locate_excerpt
        excerpt_start = spec["start"] + max(0, spec["duration"] / 2 - 15)
        quality = locate_excerpt(spec["audio"], Path(spec["folder"]), spec["fragments"], excerpt_start,
                                 min(30, spec["duration"]), language)
        if quality["match"] is None and len(quality["text"].split()) >= 10:
            intervals = []
    return {"intervals": intervals, "quality": quality}

def anchor(spec):
    from anchors import locate_excerpt
    return locate_excerpt(spec["audio"], Path(spec["folder"]), spec["fragments"], spec["start"], spec["duration"], spec["language"])

if __name__ == "__main__":
    spec = json.loads(Path(sys.argv[1]).read_text())
    result = (align if spec["mode"] == "align" else anchor)(spec)
    result["peakMemoryMB"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    Path(sys.argv[2]).write_text(json.dumps(result))
