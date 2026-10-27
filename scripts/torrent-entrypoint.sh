#!/bin/sh
set -eu
if [ ! -r /downloads/.media-volume ] || [ "$(cat /downloads/.media-volume)" != "${SONDER_MEDIA_VOLUME_ID:-missing}" ]; then
  echo 'Sonder media drive is unavailable; refusing to download onto another disk.' >&2
  exit 1
fi
exec /usr/local/bin/transmission-daemon --foreground --config-dir /config
