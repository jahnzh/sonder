#!/usr/bin/env bash
# Manage the Android emulator on the Steam Deck over SSH (issue #66): one rootless Podman
# container named sonder-emu-<name>, run as a transient systemd user unit of the same name,
# with the SDK and the AVD under ~/sonder-emu/ on the Deck.
#
# Usage: scripts/emulator-deck.sh start|stop|status
#        scripts/emulator-deck.sh install-apk <local.apk>
#        scripts/emulator-deck.sh install-firefox
#        scripts/emulator-deck.sh adb <adb arguments...>
#
# start: preflights, fetches and verifies the SDK packages once, writes the AVD, boots it
# headless with KVM and waits for sys.boot_completed. Prints boot_seconds= and memory.
# It refuses to start while a sonder-ci-run-* container or unit is active on the Deck
# (checked in preflight and again at launch; remote exit 18 maps to 8).
# stop: removes only this container and stops only this unit. status: key=value lines.
# install-firefox: fetches the pinned Firefox for Android build, checks its SHA-256 and installs it.
# adb: runs the emulator's own adb (its server listens on the Deck's 127.0.0.1:5037).
#
# Exit status: 0 ok; 1 other failure; 2 usage; 3 podman, systemd-run, lingering or /dev/kvm
# missing on the Deck; 5 SSH failed; 6 the image is missing and could not be pulled; 7 free
# disk below the threshold; 8 refused because a CI run is active; 9 the emulator did not boot
# in time or its unit died; 10 a download failed its checksum.
#
# Environment: SONDER_EMU_HOST (default deck@steamdeck), SONDER_EMU_NAME (default android34),
# SONDER_EMU_REMOTE_BASE (default $HOME/sonder-emu on the Deck; mounted at /emu in the container),
# SONDER_EMU_IMAGE (default mcr.microsoft.com/playwright:v1.64.1-noble, already on the Deck for CI),
# SONDER_EMU_MEMORY (container limit, default 4600m), SONDER_EMU_CPUS (default 4),
# SONDER_EMU_BOOT_TIMEOUT (seconds, default 300), SONDER_EMU_MIN_DISK_GB (default 10),
# SONDER_EMU_POLL_INTERVAL (seconds, default 3), SONDER_EMU_KVM_DEVICE (the device the preflight
# checks, default /dev/kvm; the unit tests point it at a file).
# CALL_TIMEOUT (120 s) caps ordinary SSH calls; SETUP_TIMEOUT (1800 s) caps preflight (image pull)
# and install-firefox (APK download), and the first-time SDK setup.
#
# No `set -e`: every step handles its own failure.
set -uo pipefail

usage() {
  echo "Usage: scripts/emulator-deck.sh start|stop|status|install-apk <apk>|install-firefox|adb <args...>" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
COMMAND=$1
shift

SONDER_EMU_HOST=${SONDER_EMU_HOST:-deck@steamdeck}
NAME=${SONDER_EMU_NAME:-android34}
# Empty means $HOME/sonder-emu on the Deck, which only the Deck can expand.
REMOTE_BASE=${SONDER_EMU_REMOTE_BASE:-}
IMAGE=${SONDER_EMU_IMAGE:-mcr.microsoft.com/playwright:v1.64.1-noble}
MEMORY=${SONDER_EMU_MEMORY:-4600m}
CPUS=${SONDER_EMU_CPUS:-4}
BOOT_TIMEOUT=${SONDER_EMU_BOOT_TIMEOUT:-300}
MIN_DISK_GB=${SONDER_EMU_MIN_DISK_GB:-10}
POLL_INTERVAL=${SONDER_EMU_POLL_INTERVAL:-3}
KVM_DEVICE=${SONDER_EMU_KVM_DEVICE:-/dev/kvm}
CALL_TIMEOUT=120
# Fetching about 2 GB of SDK packages the first time takes longer than a normal call.
SETUP_TIMEOUT=1800
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)

# Pinned SDK packages from https://dl.google.com/android/repository/repository2-3.xml and
# sys-img/google_apis/sys-img2-3.xml (SHA-1 is what those manifests publish), and the Firefox
# for Android release from archive.mozilla.org. The APK's signature was checked with apksigner
# (signer CN=Release Engineering, O=Mozilla Corporation); see docs/agents/emulator.md.
SDK_PACKAGES=(
  "emulator emulator-linux_x64-16428233.zip https://dl.google.com/android/repository/emulator-linux_x64-16428233.zip cd7362ea55dfb86a418958138dc396e74165dd01"
  "platform-tools platform-tools_r37.0.1-linux.zip https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip 477254aa5f903c15cf51001717bdf347fb6b53e0"
  "system-images/android-34/google_apis x86_64-34_r14.zip https://dl.google.com/android/repository/sys-img/google_apis/x86_64-34_r14.zip e0f6c9a0691aa27bd597d0deb1bcfdc943ac8ca7"
)
FIREFOX_VERSION=159.0
FIREFOX_URL="https://archive.mozilla.org/pub/fenix/releases/${FIREFOX_VERSION}/android/fenix-${FIREFOX_VERSION}-android-x86_64/fenix-${FIREFOX_VERSION}.multi.android-x86_64.apk"
FIREFOX_SHA256=1be332f07cb28ff8e110b8e7cf6f6415cf24c38ceff1cea18ce14867db927368
FIREFOX_PACKAGE=org.mozilla.firefox

[[ $NAME =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || { echo "[emulator-deck] SONDER_EMU_NAME must be lower-case letters, digits and dashes" >&2; exit 2; }
[[ $SONDER_EMU_HOST =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]] || { echo "[emulator-deck] SONDER_EMU_HOST has unexpected characters" >&2; exit 2; }
[[ $IMAGE =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || { echo "[emulator-deck] SONDER_EMU_IMAGE has unexpected characters" >&2; exit 2; }
[[ -z $REMOTE_BASE || $REMOTE_BASE =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "[emulator-deck] SONDER_EMU_REMOTE_BASE must be an absolute path" >&2; exit 2; }
[[ $MEMORY =~ ^[0-9]+[mg]$ ]] || { echo "[emulator-deck] SONDER_EMU_MEMORY must look like 4600m or 4g" >&2; exit 2; }
[[ $CPUS =~ ^[0-9]+$ ]] || { echo "[emulator-deck] SONDER_EMU_CPUS must be a whole number" >&2; exit 2; }
for value in "$BOOT_TIMEOUT" "$MIN_DISK_GB"; do
  [[ $value =~ ^[0-9]+$ ]] || { echo "[emulator-deck] SONDER_EMU_BOOT_TIMEOUT and SONDER_EMU_MIN_DISK_GB must be whole numbers" >&2; exit 2; }
done
[[ $POLL_INTERVAL =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "[emulator-deck] SONDER_EMU_POLL_INTERVAL must be a number of seconds" >&2; exit 2; }
[[ $KVM_DEVICE =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "[emulator-deck] SONDER_EMU_KVM_DEVICE must be an absolute path" >&2; exit 2; }

CONTAINER="sonder-emu-${NAME}"

log() {
  echo "[emulator-deck] $*" >&2
}

# remote_command <step> [arg...]: run the script on stdin on the Deck as
# `bash -s -- <step> arg...`. The step name stays visible on the command line.
remote_command() {
  local cmd="bash -s --" arg
  for arg in "$@"; do cmd+=" $(printf '%q' "$arg")"; done
  printf '%s' "$cmd"
}

# REMOTE_TIMEOUT overrides CALL_TIMEOUT for long steps (preflight image pull, install-firefox).
remote_bash() {
  timeout "${REMOTE_TIMEOUT:-$CALL_TIMEOUT}" ssh "${SSH_OPTS[@]}" "$SONDER_EMU_HOST" "$(remote_command "$@")"
}

# Shared by every remote step: the base directory, and whether a CI run is active.
REMOTE_PRELUDE='base=${BASE:-$HOME/sonder-emu}
ci_active() {
  podman ps --filter name=sonder-ci-run- --format "{{.Names}}" 2>/dev/null | grep "^sonder-ci-run-"
  systemctl --user list-units --state=active --plain --no-legend "sonder-ci-run-*" 2>/dev/null | awk "{print \$1}"
}'

# remote_step <step> <script> [arg...]: like remote_bash, with BASE and the prelude set.
remote_step() {
  local step=$1 body=$2
  shift 2
  printf 'BASE=%q\n%s\n%s\n' "$REMOTE_BASE" "$REMOTE_PRELUDE" "$body" | remote_bash "$step" "$@"
}

# Returns 0 when the Deck is ready; 3, 6, 7 or 8 as documented above; 5 when SSH failed.
# Uses SETUP_TIMEOUT: first-time image pull can take up to 900 s inside this call.
preflight() {
  local out rc
  out=$(REMOTE_TIMEOUT=$SETUP_TIMEOUT remote_step preflight '
image=$2 min_gb=$3 kvm=$4
for tool in podman systemd-run systemctl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "tool_check=fail ($tool not found)"; exit 12; }
done
# Without lingering, a unit started over SSH dies when the session closes.
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
  echo "linger_check=fail"
  exit 12
fi
if [ ! -r "$kvm" ] || [ ! -w "$kvm" ]; then
  echo "kvm_check=fail ($kvm is not readable and writable)"
  exit 12
fi
active=$(ci_active)
if [ -n "$active" ]; then
  echo "ci_active=$(echo $active)"
  exit 18
fi
mkdir -p "$base" || exit 14
free_gb=$(( $(df -Pk "$base" | awk "NR==2 {print \$4}") / 1024 / 1024 ))
echo "free_disk_gb=$free_gb min_disk_gb=$min_gb"
[ "$free_gb" -ge "$min_gb" ] || exit 13
if ! podman image exists "$image"; then
  echo "image=missing $image; pulling"
  timeout 900 podman pull -q "$image" >/dev/null 2>&1 || exit 10
fi
echo "image=present $image"
exit 0
' "$IMAGE" "$MIN_DISK_GB" "$KVM_DEVICE" 2>&1)
  rc=$?
  printf '%s\n' "$out" >&2
  case "$rc" in
    0) return 0 ;;
    12) log "The Deck is missing podman, systemd-run, user lingering or a usable /dev/kvm"; return 3 ;;
    18) log "Refusing to start: a CI run is active on ${SONDER_EMU_HOST}. Wait for it to finish."; return 8 ;;
    13) log "Less than ${MIN_DISK_GB} GB free on ${SONDER_EMU_HOST}"; return 7 ;;
    10) log "The image ${IMAGE} is missing on ${SONDER_EMU_HOST} and could not be pulled"; return 6 ;;
    14) log "Could not create the base directory on ${SONDER_EMU_HOST}"; return 1 ;;
    *) log "The preflight could not run on ${SONDER_EMU_HOST} (ssh status ${rc})"; return 5 ;;
  esac
}

# Downloads each SDK package once, checks its SHA-1, unpacks it under sdk/ and writes the AVD.
# Idempotent: an unpacked package leaves a marker with the archive's checksum.
setup_remote() {
  local out rc
  out=$(printf 'BASE=%q\n%s\n%s\n' "$REMOTE_BASE" "$REMOTE_PRELUDE" '
name=$2
shift 2
mkdir -p "$base/downloads" "$base/sdk" "$base/avd/$name.avd" "$base/home" || exit 14
for entry in "$@"; do
  set -- $entry
  dir=$1 file=$2 url=$3 sha=$4
  marker="$base/sdk/$dir/.sonder-$sha"
  [ -f "$marker" ] && continue
  if ! echo "$sha  $base/downloads/$file" | sha1sum -c --quiet - >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$base/downloads/$file.part" "$url" || { echo "download=fail $url"; rm -f "$base/downloads/$file.part"; exit 15; }
    mv "$base/downloads/$file.part" "$base/downloads/$file"
    echo "$sha  $base/downloads/$file" | sha1sum -c --quiet - || { echo "checksum=fail $file"; rm -f "$base/downloads/$file"; exit 15; }
  fi
  # The system image archive holds an x86_64/ directory; the others hold their own top directory.
  parent=$(dirname "$base/sdk/$dir")
  case "$dir" in system-images/*) parent="$base/sdk/$dir" ;; esac
  mkdir -p "$parent"
  rm -rf "$base/sdk/$dir.unpack" && mkdir -p "$base/sdk/$dir.unpack"
  unzip -q "$base/downloads/$file" -d "$base/sdk/$dir.unpack" || { echo "unzip=fail $file"; exit 15; }
  case "$dir" in
    system-images/*) rm -rf "$base/sdk/$dir/x86_64"; mv "$base/sdk/$dir.unpack/x86_64" "$base/sdk/$dir/x86_64" ;;
    *) rm -rf "$base/sdk/$dir"; mv "$base/sdk/$dir.unpack/$(basename "$dir")" "$base/sdk/$dir" ;;
  esac
  rm -rf "$base/sdk/$dir.unpack"
  touch "$marker"
  echo "unpacked=$dir"
done
cat >"$base/avd/$name.ini" <<EOF
avd.ini.encoding=UTF-8
path=/emu/avd/$name.avd
path.rel=avd/$name.avd
target=android-34
EOF
# A 720x1600 screen at 320 dpi is a 360x800 CSS-pixel phone. Tests resize it with `wm size`.
cat >"$base/avd/$name.avd/config.ini" <<EOF
avd.ini.encoding=UTF-8
AvdId=$name
avd.ini.displayname=$name
abi.type=x86_64
hw.cpu.arch=x86_64
hw.cpu.ncore=2
hw.ramSize=2048
vm.heapSize=256
image.sysdir.1=system-images/android-34/google_apis/x86_64/
tag.id=google_apis
tag.display=Google APIs
PlayStore.enabled=false
hw.lcd.width=720
hw.lcd.height=1600
hw.lcd.density=320
hw.keyboard=yes
hw.audioInput=no
hw.camera.back=none
hw.camera.front=none
hw.gps=no
disk.dataPartition.size=4G
fastboot.forceColdBoot=yes
EOF
echo "avd=$base/avd/$name.avd"
' | timeout "$SETUP_TIMEOUT" ssh "${SSH_OPTS[@]}" "$SONDER_EMU_HOST" "$(remote_command setup "$NAME" "${SDK_PACKAGES[@]}")" 2>&1)
  rc=$?
  printf '%s\n' "$out" >&2
  case "$rc" in
    0) return 0 ;;
    15) log "An SDK download failed or did not match its checksum"; return 10 ;;
    255) log "SSH failed during setup"; return 5 ;;
    *) log "Setup on ${SONDER_EMU_HOST} failed (status ${rc})"; return 1 ;;
  esac
}

# Starts the unit. Prints nothing; returns 0 when the unit started or was already running.
# Re-checks for a CI run here: setup can take up to SETUP_TIMEOUT seconds after preflight.
# Exit 18 on the Deck is mapped to 8 by cmd_start.
launch_remote() {
  remote_step launch '
name=$2 container=$3 image=$4 memory=$5 cpus=$6
active=$(ci_active)
if [ -n "$active" ]; then
  echo "ci_active=$(echo $active)"
  exit 18
fi
if podman container exists "$container" 2>/dev/null; then
  echo "already_running=$container"
  exit 0
fi
# The unit may linger as failed from an earlier run; its name must be free.
systemctl --user reset-failed "$container" >/dev/null 2>&1
# A container removed with `podman rm -f` leaves the lock files of the emulator, and the next boot then
# fails with "Running multiple emulators with the same AVD". No container uses this AVD now.
rm -rf "$base/avd/$name.avd/"*.lock
mkdir -p "$base/state"
rm -f "$base/state/$name.boot" "$base/state/$name.exit"
date +%s >"$base/state/$name.started"
# A file, not an inline command: systemd expands $ on a unit command line.
# -memory 2048: without it the emulator raises the RAM of this image to 2560 MB whatever config.ini says.
# --network host: the emulator and its adb server listen on the Deck loopback only (5554, 5555, 5037),
# and `adb reverse` reaches SSH tunnels on that loopback.
cat >"$base/state/$name.run.sh" <<'"'"'WRAPPER'"'"'
exec >"$7" 2>&1
podman run --rm --name "$1" --device /dev/kvm --network host --cpus "$5" --memory "$4" --pids-limit 4096 \
  --security-opt no-new-privileges --env HOME=/emu/home --env ANDROID_SDK_ROOT=/emu/sdk \
  --env ANDROID_AVD_HOME=/emu/avd --env ANDROID_EMULATOR_HOME=/emu/home --volume "$2:/emu:rw" "$3" \
  bash -c "/emu/sdk/platform-tools/adb start-server && exec /emu/sdk/emulator/emulator -avd $6 -no-window -no-audio -no-boot-anim -no-snapshot -wipe-data -memory 2048 -gpu swiftshader -accel on -no-metrics"
rc=$?
echo "$rc" >"$8"
WRAPPER
systemd-run --user --collect --quiet --unit "$container" \
  bash "$base/state/$name.run.sh" "$container" "$base" "$image" "$memory" "$cpus" "$name" "$base/state/$name.log" "$base/state/$name.exit" || exit 1
echo "started=$container"
' "$NAME" "$CONTAINER" "$IMAGE" "$MEMORY" "$CPUS"
}

# Prints one line: `booted <seconds>`, `booting`, or `dead <exit>`.
probe_boot() {
  remote_step probe '
name=$2 container=$3
if ! podman container exists "$container" 2>/dev/null; then
  if [ -s "$base/state/$name.exit" ] || ! systemctl --user is-active -q "$container"; then
    echo "dead $(cat "$base/state/$name.exit" 2>/dev/null || echo none)"
    exit 0
  fi
  echo booting
  exit 0
fi
done=$(podman exec "$container" /emu/sdk/platform-tools/adb shell getprop sys.boot_completed 2>/dev/null | tr -d "\r")
if [ "$done" = 1 ]; then
  [ -s "$base/state/$name.boot" ] || echo $(( $(date +%s) - $(cat "$base/state/$name.started") )) >"$base/state/$name.boot"
  echo "booted $(cat "$base/state/$name.boot")"
else
  echo booting
fi
' "$NAME" "$CONTAINER"
}

# Prints key=value lines about the container, its memory and the base directory.
status_remote() {
  remote_step status '
name=$2 container=$3
echo "host=$(uname -n)"
echo "container=$container"
if podman container exists "$container" 2>/dev/null; then
  echo "running=yes"
  echo "boot_completed=$(podman exec "$container" /emu/sdk/platform-tools/adb shell getprop sys.boot_completed 2>/dev/null | tr -d "\r")"
  echo "boot_seconds=$(cat "$base/state/$name.boot" 2>/dev/null)"
  cg=/sys/fs/cgroup$(podman inspect -f "{{.State.CgroupPath}}" "$container" 2>/dev/null)
  [ -r "$cg/memory.current" ] && echo "memory_current_bytes=$(cat "$cg/memory.current")"
  [ -r "$cg/memory.peak" ] && echo "memory_peak_bytes=$(cat "$cg/memory.peak")"
  [ -r "$cg/memory.max" ] && echo "memory_max_bytes=$(cat "$cg/memory.max")"
  # anon is the emulator itself; file is page cache that the kernel reclaims under the limit.
  [ -r "$cg/memory.stat" ] && awk '"'"'$1 == "anon" || $1 == "file" {print "memory_" $1 "_bytes=" $2}'"'"' "$cg/memory.stat"
else
  echo "running=no"
fi
echo "unit_active=$(systemctl --user is-active "$container" 2>/dev/null)"
active=$(ci_active)
echo "ci_active=$(echo $active)"
[ -d "$base" ] && echo "disk_used_kb=$(du -sk "$base" | cut -f1)"
exit 0
' "$NAME" "$CONTAINER"
}

stop_remote() {
  remote_step stop '
container=$2
# Without waiting for a stop: the emulator ignores SIGTERM long enough to outlast the cap.
podman rm -f -t 0 --ignore "$container" >/dev/null 2>&1
systemctl --user stop "$container" >/dev/null 2>&1
systemctl --user reset-failed "$container" >/dev/null 2>&1
if podman container exists "$container" 2>/dev/null; then
  echo "could not remove $container"
  exit 1
fi
echo "stopped=$container"
' "$CONTAINER"
}

cmd_start() {
  local rc deadline state
  preflight || return $?
  setup_remote || return $?
  launch_remote >&2
  rc=$?
  if [[ $rc -ne 0 ]]; then
    if [[ $rc -eq 18 ]]; then
      log "Refusing to start: a CI run is active on ${SONDER_EMU_HOST}. Wait for it to finish."
      return 8
    fi
    log "Could not start the unit ${CONTAINER} (status ${rc})"
    [[ $rc -eq 255 || $rc -eq 124 ]] && return 5
    return 1
  fi
  log "Waiting for ${CONTAINER} to boot (cap ${BOOT_TIMEOUT}s)"
  deadline=$((SECONDS + BOOT_TIMEOUT))
  while true; do
    state=$(probe_boot 2>/dev/null)
    case "$state" in
      "booted "*)
        echo "boot_seconds=${state#booted }"
        status_remote | grep -E '^memory_'
        return 0
        ;;
      "dead "*)
        log "The emulator unit died before it booted (exit ${state#dead }). Log: ${REMOTE_BASE:-~/sonder-emu}/state/${NAME}.log on the Deck"
        stop_remote >/dev/null 2>&1
        return 9
        ;;
    esac
    if (( SECONDS >= deadline )); then
      log "The emulator did not boot within ${BOOT_TIMEOUT}s; stopping it"
      stop_remote >/dev/null 2>&1
      return 9
    fi
    sleep "$POLL_INTERVAL"
  done
}

cmd_install_apk() {
  local apk=${1:-} remote_name rc
  [[ -n $apk && -f $apk && $apk == *.apk ]] || { log "install-apk needs a local .apk file"; return 2; }
  remote_name=$(basename "$apk")
  [[ $remote_name =~ ^[A-Za-z0-9._-]+$ ]] || { log "The APK file name has unexpected characters"; return 2; }
  remote_step apk_dir 'mkdir -p "$base/apks" && echo "$base/apks"' >/dev/null || return 5
  timeout 600 scp -q "${SSH_OPTS[@]}" "$apk" "${SONDER_EMU_HOST}:${REMOTE_BASE:-sonder-emu}/apks/${remote_name}" || { log "Could not copy ${apk}"; return 5; }
  remote_step install_apk '
container=$2 file=$3
podman exec "$container" /emu/sdk/platform-tools/adb install -r "/emu/apks/$file"
' "$CONTAINER" "$remote_name"
  rc=$?
  [[ $rc -eq 0 ]] || log "adb install failed (status ${rc})"
  return "$rc"
}

cmd_install_firefox() {
  local rc
  # SETUP_TIMEOUT: the APK is about 139 MB and can outlast CALL_TIMEOUT.
  REMOTE_TIMEOUT=$SETUP_TIMEOUT remote_step install_firefox '
container=$2 url=$3 sha=$4 package=$5 version=$6
file="$base/downloads/$(basename "$url")"
mkdir -p "$base/downloads"
if ! echo "$sha  $file" | sha256sum -c --quiet - >/dev/null 2>&1; then
  curl -fsSL --retry 3 -o "$file.part" "$url" || { echo "download=fail $url"; rm -f "$file.part"; exit 15; }
  mv "$file.part" "$file"
  echo "$sha  $file" | sha256sum -c --quiet - || { echo "checksum=fail $file"; rm -f "$file"; exit 15; }
fi
installed=$(podman exec "$container" /emu/sdk/platform-tools/adb shell dumpsys package "$package" 2>/dev/null | sed -n "s/^ *versionName=//p" | head -1 | tr -d "\r")
if [ "$installed" = "$version" ]; then
  echo "firefox=$version already installed"
  exit 0
fi
podman exec "$container" /emu/sdk/platform-tools/adb install -r "/emu/downloads/$(basename "$url")" || exit 1
echo "firefox=$version installed"
' "$CONTAINER" "$FIREFOX_URL" "$FIREFOX_SHA256" "$FIREFOX_PACKAGE" "$FIREFOX_VERSION"
  rc=$?
  case "$rc" in
    0) return 0 ;;
    15) log "The Firefox APK failed to download or did not match its checksum"; return 10 ;;
    *) log "Could not install Firefox (status ${rc})"; return 1 ;;
  esac
}

cmd_adb() {
  remote_step adb '
container=$2
shift 2
exec podman exec "$container" /emu/sdk/platform-tools/adb "$@"
' "$CONTAINER" "$@"
}

case "$COMMAND" in
  start) [[ $# -eq 0 ]] || usage; cmd_start ;;
  stop) [[ $# -eq 0 ]] || usage; stop_remote ;;
  status) [[ $# -eq 0 ]] || usage; status_remote ;;
  install-apk) [[ $# -eq 1 ]] || usage; cmd_install_apk "$1" ;;
  install-firefox) [[ $# -eq 0 ]] || usage; cmd_install_firefox ;;
  adb) [[ $# -ge 1 ]] || usage; cmd_adb "$@" ;;
  *) usage ;;
esac
