# localCam

iPhone'unu aynı WiFi ağındaki Linux makinesinde **gerçek bir webcam** olarak kullan — Camo'nun yaptığı işi,
Mac'e, App Store uygulamasına ve buluta uğramadan yapar.

Telefondaki Safari kamerayı **WebRTC / H.264** ile (iPhone'un donanım encoder'ı) sunucuya yollar; sunucu
RTP akışını `ffmpeg` üzerinden **v4l2loopback** sanal kamerasına yazar. Zoom, Meet, Discord, OBS, Chrome —
hepsi `localCam` adında normal bir kamera görür.

```
iPhone (Safari)  --WebRTC/H.264-->  Node sunucu  --RTP-->  ffmpeg  -->  /dev/video10  -->  Zoom/OBS/...
                  \--MJPEG/WS----->  (yedek yol)
```

## Kurulum

```bash
git clone https://github.com/kartalc23/localCam.git
cd localCam
npm install

sudo bash scripts/setup-v4l2.sh     # /dev/video10 sanal kamerasını oluşturur (kalıcı)
sudo bash scripts/setup-firewall.sh # telefon erişebilsin diye portları açar (ufw/firewalld)
bash scripts/install-service.sh     # açılışta otomatik başlasın + tepsi ikonu
```

`setup-firewall.sh` kuralları yalnızca kendi alt ağına verir (ör. `192.168.1.0/24`), internete
açmaz. Güvenlik duvarı kullanmıyorsan bu adımı atlayabilirsin.

`setup-v4l2.sh` seni `video` grubuna ekler; ilk kurulumdan sonra bir kez çıkış/giriş yapman gerekebilir.

Servis istemiyorsan elle de çalıştırabilirsin:

```bash
npm start
```

## Kullanım

1. Panel/tepsideki **localCam** ikonuna tıkla → QR kodlu masaüstü sayfası açılır
   (`http://127.0.0.1:8080/desktop`).
2. iPhone'da QR'ı okut, açılan sayfada **Yayını başlat**.
3. Görüntü uygulamasında kamerayı **localCam** olarak seç.

Tepsi ikonunun rengi durumu gösterir: gri = telefon bekleniyor, yeşil = yayında, kırmızı = hata.
Sağ tık menüsünden linki kopyalayabilir, yayını durdurabilir veya uygulamayı kapatabilirsin.

### Tek dokunuşla bağlanmak

- Telefonda sayfayı açıp **Paylaş → Ana Ekrana Ekle** de. Ana ekrana localCam ikonu düşer, tam ekran açılır.
- Sayfadaki **Açılışta otomatik başlat** düğmesini aç: uygulamayı açtığın an yayına geçmeye çalışır.
- **Sertifikayı kur** (sayfadaki link veya masaüstündeki düğme): indirdiğin profili
  *Ayarlar → Genel → VPN ve Cihaz Yönetimi*'nden yükle, sonra
  *Ayarlar → Genel → Hakkında → Sertifika Güven Ayarları*'ndan localCam CA'ya güven ver.
  Bundan sonra Safari güvenlik uyarısı vermez.

Kamera izni HTTPS istediği için sunucu kendi yerel CA'sını üretip sertifikayı imzalar. IP'n değişirse
(DHCP) sertifika bir sonraki açılışta otomatik yenilenir; CA aynı kaldığı için telefondaki güven bozulmaz.

## Ayarlar

Telefon arayüzünden: kamera (ön/arka/geniş açı), çözünürlük (540p/720p/1080p), yöntem (WebRTC/MJPEG),
ayna ve 90° döndürme. Ayna/döndürme sunucu tarafında uygulanır, yani sanal kameraya da yansır.

### Yön takibi

Sanal kamera telefonun yönünü takip eder: telefonu yatay tutunca cihaz **1920x1080**, dikey tutunca
**1080x1920** olur. Görüntü kırpılmaz, esnetilmez, siyah bantla doldurulmaz — kare neyse o.
Telefon yayın sırasında döndürüldüğünde cihaz kendini yeni şekle göre yeniden kurar.

Bunun bir bedeli var: v4l2 cihazının çözünürlüğü değiştiği için, kamerayı o sırada açık tutan
uygulama (Zoom, OBS) görüntüyü kaybedebilir ve kamerayı yeniden seçmen gerekebilir. Görüşme
sırasında telefonu döndürmemek en iyisi; hangi yönde kullanacaksan yayını o yönde başlat.

### Kopmalara dayanıklılık

Bir kez başlattıktan sonra yayın "yapışkan"dır: sayfa açık olduğu sürece telefon ağa döndüğünde,
ekran açıldığında veya WiFi değiştiğinde kendiliğinden geri gelir — tekrar düğmeye basman gerekmez.
Sunucu da telefon koptuğunda 12 saniye boyunca **son kareyi donmuş halde** tutar, ancak ondan sonra
"bekleniyor" kartına düşer; böylece kısa kesintiler toplantıda fark edilmez.

Yayın sırasında ekranın kendiliğinden kapanmaması için Screen Wake Lock kullanılır. Ancak iOS,
uygulama arka plana atıldığında veya ekranı güç tuşuyla kilitlediğinde kamerayı zorla kapatır —
bunu hiçbir web sayfası aşamaz. Telefonu tekrar açtığında yayın 1-2 saniye içinde kendi başına döner.

Sunucu tarafı ortam değişkenleriyle ayarlanır:

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `LOCALCAM_DEVICE` | `/dev/video10` | Sanal kamera cihazı |
| `LOCALCAM_WIDTH` / `LOCALCAM_HEIGHT` | `1280` / `720` | Sanal kameranın sabit çözünürlüğü |
| `LOCALCAM_FPS` | `30` | Çıkış kare hızı |
| `LOCALCAM_HTTPS_PORT` | `8443` | Telefon arayüzü |
| `LOCALCAM_HTTP_PORT` | `8080` | Masaüstü sayfası + yönlendirme |
| `LOCALCAM_RTP_PORT` | `5004` | WebRTC → ffmpeg yerel RTP portu |
| `LOCALCAM_ICE_PORTS` | `50000-50019` | WebRTC ICE için sabit UDP aralığı (güvenlik duvarı kuralı buna göre) |
| `LOCALCAM_FFLOG` | `error` | ffmpeg log seviyesi (`info` ile ayrıntı) |
| `LOCALCAM_VERBOSE` | `0` | `1` yapınca ffmpeg/WebRTC ayrıntıları |

## Sorun giderme

**`/dev/video10 yok`** — `sudo bash scripts/setup-v4l2.sh` çalıştır. Modül yüklenmiyorsa
`sudo modprobe v4l2loopback` çıktısına bak.

**Uygulama kamerayı görmüyor** — sunucu çalışırken cihaza sürekli "bekleniyor" karesi yazılır, yani
kamera her zaman "açık" görünür. Uygulamayı yeniden başlatmayı dene; Chrome/Chromium'da
`chrome://restart` bazen gerekir.

**Safari "güvenli değil" diyor** — sertifikayı kur (yukarıdaki adımlar) veya uyarıda
*Ayrıntıları göster → Bu web sitesini ziyaret et* de.

**Görüntü gelmiyor / donuyor** — telefonda yöntemi **MJPEG**'e al. WebRTC bazı ağlarda (AP isolation,
misafir ağı) engellenebilir; MJPEG tek TCP bağlantısı kullanır, her yerde çalışır ama gecikmesi
biraz daha yüksektir.

**Gecikme yüksek** — çözünürlüğü 720p'de tut, telefonu 5 GHz ağa bağla.

## Gereksinimler

Node 20+, ffmpeg, openssl, `v4l2loopback` modülü (CachyOS/Arch çekirdeklerinde hazır gelir),
iOS 14.5+ Safari. Tepsi ikonu için StatusNotifierItem destekleyen bir panel (Noctalia, Waybar tray,
KDE Plasma, GNOME + AppIndicator).
