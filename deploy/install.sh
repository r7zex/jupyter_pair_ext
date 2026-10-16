#!/bin/sh
set -eu
PAIR_VERSION=0.6.7
if [ "$(id -u)" != 0 ]; then
    echo "Run this downloaded installer with sudo sh pair-notebook-install.sh" >&2
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
PAIR_RELEASE="https://github.com/r7zex/jupyter_pair_ext/releases/download/v${PAIR_VERSION}"
curl --fail --location --proto '=https' --proto-redir '=https' "$PAIR_RELEASE/pair-notebook-install.pyz" -o "$PAIR_DOWNLOAD/pair-notebook-install.pyz"
curl --fail --location --proto '=https' --proto-redir '=https' "$PAIR_RELEASE/SHA256SUMS" -o "$PAIR_DOWNLOAD/SHA256SUMS"
(cd "$PAIR_DOWNLOAD" && awk '$2 == "pair-notebook-install.pyz" { print }' SHA256SUMS > installer.sha256 && test -s installer.sha256 && sha256sum --check installer.sha256)
python3 "$PAIR_DOWNLOAD/pair-notebook-install.pyz" "$@"
