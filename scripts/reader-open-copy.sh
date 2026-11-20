#!/usr/bin/env bash
# A copy of production for scripts/measure-reader-open.mjs (ADR 0025): the deployed image on a copy of the database,
# with every background loop paused, no torrent client, no alignment pool, no mail, and the media mounted read-only.
# Nothing the measurement opens, saves or moves reaches the owner's reading place, listening place, bookmarks or
# history. A Caddy in front of the copy compresses as the production site block does (encode zstd gzip), so the bytes
# measured are the bytes a browser transfers.
#
#   scripts/reader-open-copy.sh start    # copy on 127.0.0.1:$APP_PORT, Caddy on 127.0.0.1:$PORT; prints the URL
#   scripts/reader-open-copy.sh stop     # removes the container, the Caddy and the copy
#
# Run it on the production machine. SONDER_PROD_DIR is the production work tree (its .env and data/ are read, never
# written); SONDER_COPY_IMAGE the image to run (default: the deployed one).
set -euo pipefail

PROD_DIR="${SONDER_PROD_DIR:-/home/jahn/audiobook_streamer}"
IMAGE="${SONDER_COPY_IMAGE:-sonder-audiobooks:local}"
APP_PORT="${SONDER_COPY_APP_PORT:-3105}"
PORT="${SONDER_COPY_PORT:-3106}"
NAME="sonder-reader-open-copy"
STATE="${SONDER_COPY_DIR:-${XDG_RUNTIME_DIR:-/tmp}/$NAME}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

stop() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ -f "$STATE/caddy.pid" ]; then kill "$(cat "$STATE/caddy.pid")" 2>/dev/null || true; fi
  rm -rf "$STATE"
}

case "${1:-}" in
  start)
    if [ "$APP_PORT" = 3001 ] || [ "$PORT" = 3001 ]; then echo "reader-open-copy: port 3001 is production" >&2; exit 2; fi
    [ -f "$PROD_DIR/.env" ] || { echo "reader-open-copy: no .env in $PROD_DIR" >&2; exit 2; }
    stop
    mkdir -p "$STATE/data"
    chmod 700 "$STATE"
    # An online backup, so the running server is not disturbed; then the copy is paused before anything starts on it.
    (cd "$ROOT" && node scripts/backup-db.mjs "$PROD_DIR/data/sonder.db" "$STATE/data/sonder.db")
    cp "$PROD_DIR/data/.encryption-key" "$STATE/data/.encryption-key"
    (cd "$ROOT" && node --input-type=module -e '
      import Database from "better-sqlite3";
      const db = new Database(process.argv[1]);
      for (const id of ["acquisitions", "server-copies", "series-acquisition", "alignment", "ebook-set", "backups"])
        db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)").run(`activityPaused:${id}`, "1");
      db.close();
    ' "$STATE/data/sonder.db")
    MEDIA="$(sed -n 's/^MEDIA_ROOT=//p' "$PROD_DIR/.env" | tail -1)"
    MEDIA="${MEDIA:-/mnt/usb_4t_1/sonder}"
    docker run -d --name "$NAME" --network host --init --read-only --tmpfs /tmp:size=64m \
      --user "$(id -u):$(id -g)" \
      --env-file "$PROD_DIR/.env" \
      -e NODE_ENV=production -e HOST=127.0.0.1 -e PORT="$APP_PORT" -e DATA_DIR=/app/data -e MEDIA_ROOT="$MEDIA" \
      -e REQUIRE_MEDIA_MOUNT=true -e TRANSMISSION_RPC_URL= -e ALIGNMENT_POOL_ENABLED=0 -e RESEND_API_KEY= \
      -v "$STATE/data:/app/data" -v "$MEDIA:$MEDIA:ro" "$IMAGE" >/dev/null
    cat > "$STATE/Caddyfile" <<EOF
{
	admin off
	auto_https off
}
http://127.0.0.1:$PORT {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$APP_PORT
}
EOF
    nohup caddy run --config "$STATE/Caddyfile" --adapter caddyfile >"$STATE/caddy.log" 2>&1 &
    echo $! > "$STATE/caddy.pid"
    for _ in $(seq 1 60); do
      if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
        echo "reader-open-copy: $IMAGE on a copy of the database at http://127.0.0.1:$PORT"
        exit 0
      fi
      sleep 1
    done
    echo "reader-open-copy: the copy did not answer /api/health; docker logs $NAME" >&2
    exit 1
    ;;
  stop)
    stop
    echo "reader-open-copy: removed"
    ;;
  *)
    echo "usage: scripts/reader-open-copy.sh start|stop" >&2
    exit 2
    ;;
esac
