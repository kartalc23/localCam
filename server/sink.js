import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const FONT = "sans";

/** Normalde v4l2 cihazina yazariz. Hata ayiklarken LOCALCAM_DEVICE=out.mp4 gibi
 *  bir dosya (veya "null") verilerek ayni boru hatti cihazsiz test edilebilir. */
function outputArgs() {
  const dev = config.device;
  if (dev === "null") return ["-f", "null", "-"];
  if (dev.startsWith("/dev/video")) return ["-f", "v4l2", dev];
  return ["-y", dev]; // uzantidan muxer secilir (ornegin .mp4)
}

/** Telefon dikey/yatay dondugunde cihaz cozunurlugu sabit kalsin diye
 *  goruntu her zaman WxH icine sigdirilip ortalanir.
 *  Ayna/dondurme sunucu tarafinda uygulanir ki iki yayin modunda da ayni davransin. */
function scaleFilter({ mirror = false, rotate = 0 } = {}) {
  const { width: w, height: h } = config;
  const pre = [];
  if (mirror) pre.push("hflip");
  if (rotate === 90) pre.push("transpose=1");
  else if (rotate === 180) pre.push("transpose=1", "transpose=1");
  else if (rotate === 270) pre.push("transpose=2");
  return [
    ...pre,
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=fast_bilinear`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "format=yuv420p",
  ].join(",");
}

function idleFilter(text) {
  const { width: w, height: h } = config;
  const safe = String(text).replace(/['\\]/g, "");
  return [
    `drawtext=font=${FONT}:text='localCam':fontcolor=0xE6EDF3:fontsize=${Math.round(h / 9)}:x=(w-tw)/2:y=(h/2)-th`,
    `drawtext=font=${FONT}:text='${safe}':fontcolor=0x8B949E:fontsize=${Math.round(h / 24)}:x=(w-tw)/2:y=(h/2)+(th/2)`,
    "format=yuv420p",
  ].join(",");
}

export class V4L2Sink extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.mode = "off";
    this.queue = Promise.resolve();
    this.startedAt = 0;
    this.transform = { mirror: false, rotate: 0 };
    this.lastRtp = null;
  }

  /** Ayna/dondurme degisince o anki yayin ayni ayarlarla yeniden baslatilir. */
  async setTransform(next) {
    this.transform = {
      mirror: !!next.mirror,
      rotate: [0, 90, 180, 270].includes(next.rotate) ? next.rotate : 0,
    };
    if (this.mode === "webrtc" && this.lastRtp) return this.startRtp(this.lastRtp);
    if (this.mode === "mjpeg") return this.startMjpeg();
    if (this.mode === "idle") return this.startIdle();
    return null;
  }

  /** Cihaz var mi ve yazilabilir mi? */
  check() {
    const dev = config.device;
    if (!dev.startsWith("/dev/video")) return { ok: true };
    if (!fs.existsSync(dev)) {
      return { ok: false, reason: `${dev} yok. Once: sudo bash scripts/setup-v4l2.sh` };
    }
    try {
      fs.accessSync(dev, fs.constants.W_OK);
    } catch {
      return { ok: false, reason: `${dev} yazilabilir degil (video grubuna ekli misin?)` };
    }
    return { ok: true };
  }

  /** Tum gecisler sirayla calissin; ayni anda iki ffmpeg cihaza yazmasin. */
  #serial(fn) {
    this.queue = this.queue.then(fn, fn);
    return this.queue;
  }

  #spawn(mode, args, { stdin = "ignore" } = {}) {
    const proc = spawn(config.ffmpeg, args, { stdio: [stdin, "ignore", "pipe"] });
    this.proc = proc;
    this.mode = mode;
    this.startedAt = Date.now();

    let stderr = "";
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-4000);
      if (config.verbose) process.stderr.write(`[ffmpeg:${mode}] ${s}`);
    });

    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return; // zaten degistirildi
      this.proc = null;
      this.mode = "off";
      const clean = signal === "SIGTERM" || signal === "SIGKILL";
      if (!clean) this.emit("crash", { mode, code, stderr: stderr.trim() });
      this.emit("changed", this.mode);
    });

    proc.on("error", (err) => this.emit("crash", { mode, code: -1, stderr: err.message }));
    this.emit("changed", this.mode);
    return proc;
  }

  async #kill() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.mode = "off";
    await new Promise((resolve) => {
      const timer = setTimeout(() => proc.kill("SIGKILL"), 1500);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.kill("SIGTERM");
    });
  }

  stop() {
    return this.#serial(() => this.#kill());
  }

  /** Telefon bagli degilken cihazi canli tutan bilgi karti. */
  startIdle(text = "iPhone bekleniyor") {
    return this.#serial(async () => {
      await this.#kill();
      if (!this.check().ok) return;
      this.#spawn("idle", [
        "-hide_banner", "-loglevel", config.ffmpegLog, "-nostdin",
        "-re", "-f", "lavfi", "-i", `color=c=0x0D1117:s=${config.width}x${config.height}:r=10`,
        "-vf", idleFilter(text),
        ...outputArgs(),
      ]);
    });
  }

  /** WebRTC yolu: ffmpeg RTP'yi SDP tarifiyle dinler. */
  startRtp(args) {
    const { payloadType, encodingName, fmtp } = args;
    this.lastRtp = args;
    return this.#serial(async () => {
      await this.#kill();
      fs.mkdirSync(config.runDir, { recursive: true });
      const sdpPath = path.join(config.runDir, "stream.sdp");
      const sdp = [
        "v=0",
        "o=- 0 0 IN IP4 127.0.0.1",
        "s=localCam",
        "c=IN IP4 127.0.0.1",
        "t=0 0",
        `m=video ${config.rtpPort} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${encodingName}/90000`,
        ...(fmtp ? [`a=fmtp:${payloadType} ${fmtp}`] : []),
        "",
      ].join("\n");
      fs.writeFileSync(sdpPath, sdp);

      this.#spawn("webrtc", [
        "-hide_banner", "-loglevel", config.ffmpegLog, "-nostdin",
        "-protocol_whitelist", "file,udp,rtp",
        "-fflags", "nobuffer", "-flags", "low_delay",
        "-probesize", "200000", "-analyzeduration", "2000000",
        "-max_delay", "0", "-reorder_queue_size", "64",
        "-i", sdpPath,
        "-vf", scaleFilter(this.transform),
        "-r", String(config.fps),
        ...outputArgs(),
      ]);
    });
  }

  /** Fallback yolu: telefon JPEG kareleri WebSocket ile yollar. */
  startMjpeg() {
    return this.#serial(async () => {
      await this.#kill();
      const proc = this.#spawn(
        "mjpeg",
        [
          "-hide_banner", "-loglevel", config.ffmpegLog,
          "-f", "mjpeg", "-use_wallclock_as_timestamps", "1", "-i", "pipe:0",
          "-vf", scaleFilter(this.transform),
          "-r", String(config.fps),
          ...outputArgs(),
        ],
        { stdin: "pipe" },
      );
      proc.stdin.on("error", () => {}); // kapanan pipe'a yazma yarisini yut
      return proc;
    });
  }

  /** MJPEG modunda tek bir JPEG karesi yaz. */
  writeFrame(buf) {
    const proc = this.proc;
    if (this.mode !== "mjpeg" || !proc?.stdin?.writable) return false;
    return proc.stdin.write(buf);
  }
}
