#!/usr/bin/env bash
# localCam'i kullanici systemd servisi olarak kurar: oturum acilir acilmaz
# sunucu ve tepsi ikonu hazir olur. Root gerekmez.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE_BIN="$(command -v node)"

if [[ ! -e /dev/video10 ]]; then
  echo "Uyari: /dev/video10 yok. Once:  sudo bash ${REPO}/scripts/setup-v4l2.sh"
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/localcam.service" <<UNIT
[Unit]
Description=localCam - iPhone sanal webcam koprusu
After=graphical-session.target network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO}
ExecStart=${NODE_BIN} ${REPO}/server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT

# Tepsi ikonu ve "linki kopyala" icin oturum degiskenleri gerekli.
systemctl --user import-environment WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP XDG_RUNTIME_DIR 2>/dev/null || true

systemctl --user daemon-reload
systemctl --user enable --now localcam.service
sleep 1
systemctl --user --no-pager --lines=0 status localcam.service || true

cat <<MSG

Kuruldu.
  durum:   systemctl --user status localcam
  loglar:  journalctl --user -u localcam -f
  durdur:  systemctl --user stop localcam
  kaldir:  systemctl --user disable --now localcam
MSG
