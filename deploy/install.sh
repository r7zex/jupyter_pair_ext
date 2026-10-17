#!/bin/sh
set -eu
# Release packaging embeds the installer and verified server payload below.
PAIR_VERSION=__PAIR_VERSION__
PAIR_DEFAULT_MODE=__PAIR_DEFAULT_MODE__
if [ "$(id -u)" != 0 ]; then
    if command -v sudo >/dev/null; then
        exec sudo sh "$0" "$@"
    fi
    echo "Run this utility as root, or use an account with sudo access." >&2
    exit 1
fi
. /etc/os-release
case "$ID:$VERSION_ID" in
    ubuntu:24.04|debian:12) ;;
    *) echo "Supported: Ubuntu 24.04 LTS and Debian 12 with systemd." >&2; exit 1 ;;
esac
test -d /run/systemd/system || { echo "A running systemd is required." >&2; exit 1; }
if ! command -v python3 >/dev/null || ! command -v curl >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y --no-install-recommends python3 curl ca-certificates
fi
PAIR_DOWNLOAD=$(mktemp -d)
trap 'rm -rf "$PAIR_DOWNLOAD"' EXIT HUP INT TERM
awk 'payload { print } /^__PAIR_NOTEBOOK_PAYLOAD__$/ { payload = 1 }' "$0" | base64 --decode > "$PAIR_DOWNLOAD/pair-notebook-install.pyz"
printf '%s  pair-notebook-install.pyz\n' '__PAIR_INSTALLER_SHA256__' > "$PAIR_DOWNLOAD/installer.sha256"
(cd "$PAIR_DOWNLOAD" && sha256sum --check installer.sha256)
python3 "$PAIR_DOWNLOAD/pair-notebook-install.pyz" --mode "$PAIR_DEFAULT_MODE" "$@"
exit 0
__PAIR_NOTEBOOK_PAYLOAD__
