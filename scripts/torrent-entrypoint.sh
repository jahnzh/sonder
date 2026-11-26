#!/bin/sh
# sonder-torrents' entrypoint: refuse to start without the media drive, then the image's own start, which connects its
# own VPN (PIA, with port forwarding) and starts Transmission only once the tunnel is up (#911).
set -eu
if [ ! -r /downloads/.media-volume ] || [ "$(cat /downloads/.media-volume)" != "${SONDER_MEDIA_VOLUME_ID:-missing}" ]; then
  echo 'Sonder media drive is unavailable; refusing to download onto another disk.' >&2
  exit 1
fi
exec dumb-init /etc/openvpn/start.sh
