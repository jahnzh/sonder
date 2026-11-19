# Restarts from the web UI go through an allowlisted SSH key

**Status (2026-11-19).** Restart is now on a worker's page in Activity › Server (`#activity/server/<worker>`, #520), which replaced the Activity page; the decision stands.

The Activity page (#357) restarts a background process (an alignment worker on WSL or lisa, the local torrent client) by calling SSH with a key whose authorised command is a fixed list of named restarts, like the existing alignment-pool key. The web server never gets the docker socket, and the page is not a shell.

## Considered Options
- **Mount the docker socket into `sonder`.** Simplest, but a compromise of the web app (internet-facing through Caddy) would be root on the machine.
- **Show the command and let the owner run it.** Safe, but it fails the point of the page: an outage like the torrent client one on 2026-11-06 stays unfixed until the owner is at a terminal.
- **Allowlisted SSH key (chosen).** Reuses the pool-key pattern; adding a restart target is one named entry, and an unknown name is refused on the host.

## Consequences
- Each restart target needs a host-side entry; a new kind of target is a deliberate change on that host.
- Nothing restarts automatically: the page flags a down process and offers the button (owner decision, 2026-11-09), because the VPN container already restarts often and automatic restarts could hide a real fault.
- Updating worker code stays a script, not a button.

## Status on 2026-11-15
- Built for the alignment workers (#357, PR #452): the server holds the allowlist, one constant command (`systemctl --user restart sonder-ctc-worker.service`), and sends it over the alignment pool's SSH connection with an argument list.
- Not built: the host-side entry. The pool key has no forced command in `authorized_keys` on WSL or lisa, so "an unknown name is refused on the host" does not hold yet; the refusal is in the server only. A compromise of the web app could run other commands as that user on the pool hosts, as it could before this ADR.
- Not built: a restart for the local torrent client.
