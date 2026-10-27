"""Explicit one-time download of model weights; no user media is uploaded."""
import os
from pathlib import Path
from faster_whisper.utils import download_model
from anchors import MODEL_REVISION
root = Path(os.environ.get("MEDIA_ROOT", "/mnt/usb_4t_1/sonder")).resolve()
marker = root / ".media-volume"
expected = os.environ.get("MEDIA_VOLUME_ID")
if expected and (not marker.is_file() or marker.read_text().strip() != expected):
    raise RuntimeError("The mounted media volume is unavailable.")
folder = root / "alignment" / "models" / "whisper"
folder.mkdir(parents=True, exist_ok=True)
download_model("tiny", cache_dir=str(folder), revision=MODEL_REVISION)
print("Local Whisper tiny weights are ready on the media drive (about 75 MB).")
