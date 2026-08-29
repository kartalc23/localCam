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
# max_buffers dusuk verilirse Chromium istedigi tampon sayisini alamayabiliyor: varsayilan birakildi
options v4l2loopback video_nr=${DEVICE_NR} card_label=${LABEL} exclusive_caps=1
CONF

echo ">> acilista yuklenmesi icin modules-load.d ayari yaziliyor"
echo v4l2loopback > /etc/modules-load.d/localcam.conf

USER_ID="$(id -u "$TARGET_USER")"
user_systemctl() {
  sudo -u "$TARGET_USER" XDG_RUNTIME_DIR="/run/user/${USER_ID}" systemctl --user "$@" 2>/dev/null
}

holders() {
  local dev="$1" out=""
  for p in /proc/[0-9]*; do
    if ls -l "$p/fd" 2>/dev/null | grep -q "$dev"; then
      out="${out}  pid ${p#/proc/}: $(tr '\0' ' ' < "$p/cmdline" | cut -c1-60)\n"
    fi
  done
  printf "%b" "$out"
}

echo ">> modul yeniden yukleniyor"
if lsmod | grep -q '^v4l2loopback'; then
  SERVICE_WAS_UP=no
  if user_systemctl is-active --quiet localcam; then
    SERVICE_WAS_UP=yes
    echo "   localcam servisi geciciye durduruluyor"
    user_systemctl stop localcam
    sleep 1
  fi

  if ! rmmod v4l2loopback 2>/dev/null; then
    echo
    echo "HATA: modul kullanimda, yeni ayarlar uygulanamadi." >&2
    echo "Cihazi acik tutanlar:" >&2
    holders "video${DEVICE_NR}" >&2
    echo "Bunlari (ornegin tarayiciyi) kapatip betigi tekrar calistir." >&2
    [[ $SERVICE_WAS_UP == yes ]] && user_systemctl start localcam
    exit 1
  fi
fi
modprobe v4l2loopback

DEV="/dev/video${DEVICE_NR}"
for _ in $(seq 1 20); do [[ -e $DEV ]] && break; sleep 0.1; done

if [[ ! -e $DEV ]]; then
  echo "HATA: ${DEV} olusmadi." >&2
  exit 1
fi

if [[ ${SERVICE_WAS_UP:-no} == yes ]]; then
  echo ">> localcam servisi yeniden baslatiliyor"
  user_systemctl start localcam
fi

if ! id -nG "$TARGET_USER" | grep -qw video; then
  echo ">> $TARGET_USER kullanicisi 'video' grubuna ekleniyor (yeniden oturum acman gerekebilir)"
  usermod -aG video "$TARGET_USER"
fi

echo
echo "Hazir: $DEV"
v4l2-ctl --device "$DEV" --info 2>/dev/null | sed -n '1,8p' || true
