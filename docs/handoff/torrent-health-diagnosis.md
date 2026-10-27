# Issue #3 — transmission-openvpn unhealthy: diagnosis (2026-10-27)

> **Historical note.** This records one working session on 2026-10-27 and is not current instructions. Sonder is live at https://sonder.pecori.no (Caddy → 127.0.0.1:3001); see `README.md` for the current setup.

All checks read-only (docker inspect/logs/exec of read-only commands, RPC session-get/port-test/torrent-get). Nothing was restarted or reconfigured.

## Evidence
- `transmission-openvpn` (haugene, PIA `de_frankfurt`, bridge network, compose file `/home/jahn/homelab/docker/docker-compose.yml`): health `unhealthy`, FailingStreak 24, every probe output `DNS resolution failed`.
- `sonder-torrents` shares its network namespace (`network_mode: container:...`); it has no healthcheck, so `docker ps` shows it as plain "Up".
- The OpenVPN tunnel IS up: `Initialization Sequence Completed` at 10:55:47 UTC, `tun0` = 10.82.192.167, `0.0.0.0/1` + `128.0.0.0/1` routed via tun0.
- Egress through the VPN works: `ping 1.1.1.1` 0% loss (~21 ms); `https://1.1.1.1/cdn-cgi/trace` → `ip=217.19.30.39 loc=DE` (PIA exit, not the home IP).
- DNS is broken: `/etc/resolv.conf` = `nameserver 10.0.0.243` (pushed by PIA via `dhcp-option DNS`); `nslookup google.com` → `server can't find google.com: REFUSED`. `nslookup google.com 1.1.1.1` (through the tunnel) resolves fine.
- Knock-on failures, all DNS:
  - PIA port-forward script: `curl: (28) Resolving timed out` → `getSignature error … Login failed!` → `bindPort error`; peer port is unset ("setting transmission port to " blank).
  - sonder-torrents: `Couldn't look up 'dht.transmissionbt.com:6881': Temporary failure in name resolution` → no DHT bootstrap; tracker hostnames can't resolve either.
  - RPC `port-test` → `Couldn't test port: No Response (0)` after ~15 s.
  - Active Sonder torrent "George R. R. Martin's Game of Thrones" sits at 0.11 % (status downloading, no tracker stats).
- RPC from the host as Sonder reaches it (`TRANSMISSION_RPC_URL` → 172.17.0.2:9092): reachable, 401 without credentials, `session-get` succeeds with credentials (Transmission 4.0.5). So Sonder can queue torrents, but they never progress.

## Root cause
Not the VPN connection and not the healthcheck script: PIA's in-tunnel DNS resolver 10.0.0.243 is answering REFUSED for this server/session. The healthcheck correctly reports it. Everything that needs name resolution (trackers, DHT bootstrap, PIA port forwarding) fails, so local fallback downloads silently stall.

## Recommended fix (needs the user; affects radarr/sonarr)
1. In `/home/jahn/homelab/docker/docker-compose.yml`, service `transmission-openvpn`, add:
   ```
   OVERRIDE_DNS_1=1.1.1.1
   OVERRIDE_DNS_2=9.9.9.9
   ```
   (supported by this image's `start.sh`; queries still leave through tun0 because PIA pushes `redirect-gateway def1`). Alternatively/also try another PIA region (`OPENVPN_CONFIG`) if 10.0.0.243 keeps refusing — first try simply recreating the container, since PIA DNS refusals are often session-specific.
2. Recreate `transmission-openvpn`, then recreate `sonder-torrents` (its `container:<id>` network reference breaks when the VPN container is recreated).
3. Check that `TRANSMISSION_RPC_URL` (hard-coded bridge IP 172.17.0.2) still matches the VPN container's new IP; otherwise Sonder's new health line will show "cannot be reached".
4. Verify: `docker inspect --format '{{.State.Health.Status}}' transmission-openvpn` → healthy; Sonder Settings → "Your home server" line shows "Local torrents are ready"; the stalled Game of Thrones torrent starts moving.

## What the app now does
- `GET /api/torrents/health[?fresh=1]` → `{status: ok|offline|unreachable|auth|error|unconfigured, session, network: ok|port-closed|failed|unknown, version, message, checkedAt}`. Uses `session-get` + Transmission's `port-test` (which needs working DNS + VPN egress). Cached 5 min when healthy, 30 s when failing; in-flight probes are shared. No URL, username or password in the response.
- Against the live client right now it returns `status: "offline", network: "failed"` (~15 s probe).
- Local fallback in `acquire()` re-checks health (≤15 s old) and, if not ok, logs `Local torrent fallback refused for <hash>: <status> (...)` and marks the job as error with the health message instead of queueing.
