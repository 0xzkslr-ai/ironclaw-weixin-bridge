#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="${SCRIPT_DIR}/ironclaw-weixin-bridge.service"
UNIT_DST="/etc/systemd/system/ironclaw-weixin-bridge.service"

install -m 644 "${UNIT_SRC}" "${UNIT_DST}"
systemctl daemon-reload
systemctl enable --now ironclaw-weixin-bridge.service
systemctl status ironclaw-weixin-bridge.service --no-pager --lines=30
