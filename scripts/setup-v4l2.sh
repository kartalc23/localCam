#!/usr/bin/env bash
# Sanal kamera cihazini olusturur ve her acilista gelmesi icin kalici hale getirir.
# Kullanim: sudo bash scripts/setup-v4l2.sh
set -euo pipefail

DEVICE_NR="${LOCALCAM_DEVICE_NR:-10}"
LABEL="${LOCALCAM_LABEL:-localCam}"
TARGET_USER="${SUDO_USER:-$USER}"

if [[ $EUID -ne 0 ]]; then
  echo "Bu betik root gerektiriyor:  sudo bash scripts/setup-v4l2.sh" >&2
  exit 1
fi

if ! modinfo v4l2loopback >/dev/null 2>&1; then
  echo "v4l2loopback modulu bulunamadi." >&2
  echo "Arch/CachyOS:  pacman -S v4l2loopback-dkms   (veya kernel ile gelen surumu kullan)" >&2
  exit 1
fi

echo ">> modprobe.d ayari yaziliyor"
cat > /etc/modprobe.d/localcam.conf <<CONF
options v4l2loopback video_nr=${DEVICE_NR} card_label=${LABEL} exclusive_caps=1 max_buffers=2
CONF

echo ">> acilista yuklenmesi icin modules-load.d ayari yaziliyor"
echo v4l2loopback > /etc/modules-load.d/localcam.conf

echo ">> modul yeniden yukleniyor"
if lsmod | grep -q '^v4l2loopback'; then
  # Cihazi kullanan bir uygulama varsa rmmod basarisiz olur; bu durumda mevcut haliyle devam.
  rmmod v4l2loopback 2>/dev/null || echo "   (modul kullanimda, mevcut cihaz korunuyor)"
fi
modprobe v4l2loopback

DEV="/dev/video${DEVICE_NR}"
for _ in $(seq 1 20); do [[ -e $DEV ]] && break; sleep 0.1; done

if [[ ! -e $DEV ]]; then
  echo "HATA: ${DEV} olusmadi." >&2
  exit 1
fi

if ! id -nG "$TARGET_USER" | grep -qw video; then
  echo ">> $TARGET_USER kullanicisi 'video' grubuna ekleniyor (yeniden oturum acman gerekebilir)"
  usermod -aG video "$TARGET_USER"
fi

echo
echo "Hazir: $DEV"
v4l2-ctl --device "$DEV" --info 2>/dev/null | sed -n '1,8p' || true
