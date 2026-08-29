import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

const num = (v, d) => (v === undefined ? d : Number(v));

export const ROOT = path.resolve(here, "..");

export const config = {
  // Sanal kamera cihazi (scripts/setup-v4l2.sh ile olusturulur)
  device: process.env.LOCALCAM_DEVICE || "/dev/video10",

  // Sanal kameranin sabit cikti formati. Telefon yatay/dikey donse de
  // cihazin cozunurlugu degismesin diye letterbox/pillarbox uygulanir.
  width: num(process.env.LOCALCAM_WIDTH, 1920),
  height: num(process.env.LOCALCAM_HEIGHT, 1080),
  fps: num(process.env.LOCALCAM_FPS, 30),

  httpsPort: num(process.env.LOCALCAM_HTTPS_PORT, 8443),
  httpPort: num(process.env.LOCALCAM_HTTP_PORT, 8080),

  // WebRTC'den gelen RTP'nin ffmpeg'e aktarildigi yerel UDP portu
  rtpPort: num(process.env.LOCALCAM_RTP_PORT, 5004),

  // ICE icin sabit UDP araligi: guvenlik duvarinda dar bir kural yazilabilsin diye.
  icePortRange: (process.env.LOCALCAM_ICE_PORTS || "50000-50019")
    .split("-").map(Number),

  publicDir: path.join(ROOT, "public"),
  certDir: process.env.LOCALCAM_CERT_DIR || path.join(ROOT, ".certs"),
  runDir: path.join(ROOT, ".run"),

  ffmpeg: process.env.LOCALCAM_FFMPEG || "ffmpeg",
  ffmpegLog: process.env.LOCALCAM_FFLOG || "info",
  verbose: process.env.LOCALCAM_VERBOSE === "1",
};
