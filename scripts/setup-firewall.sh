#!/usr/bin/env bash
# Yerel agdan localCam'e erisim icin guvenlik duvarinda gerekli portlari acar.
# Kurallar sadece kendi alt agina verilir, internete acilmaz.
# Kullanim: sudo bash scripts/setup-firewall.sh
set -euo pipefail

HTTPS_PORT="${LOCALCAM_HTTPS_PORT:-8443}"
HTTP_PORT="${LOCALCAM_HTTP_PORT:-8080}"
ICE_RANGE="${LOCALCAM_ICE_PORTS:-50000-50019}"

if [[ $EUID -ne 0 ]]; then
  echo "Bu betik root gerektiriyor:  sudo bash scripts/setup-firewall.sh" >&2
  exit 1
fi

# Varsayilan rotanin uzerinden gittigi arayuzun alt agini bul (orn. 192.168.1.0/24)
SUBNET="$(ip -4 route show scope link | awk '/src/ {print $1; exit}')"
if [[ -z "${SUBNET:-}" ]]; then
  echo "Alt ag bulunamadi, kurallar tum kaynaklara aciliyor." >&2
  SUBNET="any"
fi
echo ">> alt ag: ${SUBNET}"

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "^Status: active"; then
  echo ">> ufw kurallari ekleniyor"
  if [[ $SUBNET == "any" ]]; then
    ufw allow "${HTTPS_PORT}/tcp"  comment "localCam telefon arayuzu"
    ufw allow "${HTTP_PORT}/tcp"   comment "localCam masaustu sayfasi"
    ufw allow "${ICE_RANGE//-/:}/udp" comment "localCam WebRTC ICE"
  else
    ufw allow from "$SUBNET" to any port "$HTTPS_PORT" proto tcp comment "localCam telefon arayuzu"
    ufw allow from "$SUBNET" to any port "$HTTP_PORT"  proto tcp comment "localCam masaustu sayfasi"
    ufw allow from "$SUBNET" to any port "${ICE_RANGE//-/:}" proto udp comment "localCam WebRTC ICE"
  fi
  ufw reload >/dev/null || true
  echo
  ufw status | grep -i localcam || ufw status | head -20

elif command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
  echo ">> firewalld kurallari ekleniyor"
  firewall-cmd --permanent --add-port="${HTTPS_PORT}/tcp"
  firewall-cmd --permanent --add-port="${HTTP_PORT}/tcp"
  firewall-cmd --permanent --add-port="${ICE_RANGE/-/-}/udp"
  firewall-cmd --reload
  firewall-cmd --list-ports

else
  echo "Aktif ufw/firewalld bulunamadi. Guvenlik duvari kullanmiyorsan bir sey yapman gerekmiyor."
  echo "Elle acman gereken portlar: ${HTTPS_PORT}/tcp, ${HTTP_PORT}/tcp, ${ICE_RANGE}/udp"
fi
