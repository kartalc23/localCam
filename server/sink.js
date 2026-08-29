import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const FONT = "sans";

/* Cihaza yazan tek bir kalici ffmpeg vardir ve asla durmaz: girdisi ham kare
   akisidir. Telefon bagli degilken Node bekleme karesini, bagliyken cozulen
   kareleri ayni boruya yazar.

   Bunun sebebi: v4l2loopback exclusive_caps=1 ile bir yazici bagli degilken
   cihazi "Video Output" olarak bildirir ve Chromium/Chrome onu kamera saymaz.
   Cihaza yazan sureci her yayin degisiminde yeniden baslatmak, tarayicinin
   kamerayi kaybetmesine yol aciyordu. */

const FRAME_BYTES = () => (config.width * config.height * 3) / 2; // yuv420p
const TICK_INTERVAL = 100;  // cihazi besleme araligi (ms)
const SOURCE_SILENT_MS = 250; // kaynak bu sureden fazla susarsa son kare tekrarlanir
const WRITER_RETRY = 800;

function transformFilter({ mirror = false, rotate = 0 } = {}) {
  const { width: w, height: h } = config;
  const pre = [];
  if (mirror) pre.push("hflip");
  if (rotate === 90) pre.push("transpose=1");
  else if (rotate === 180) pre.push("transpose=1", "transpose=1");
  else if (rotate === 270) pre.push("transpose=2");
  // En/boy orani korunur, ASLA kirpilmaz: artan yer siyahla doldurulur.
  return [
    ...pre,
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=bicubic`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "format=yuv420p",
  ].join(",");
}

function idleFilter(text) {
  const { height: h } = config;
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
    this.writer = null;      // cihaza yazan kalici ffmpeg
    this.source = null;      // telefon akisini cozen gecici ffmpeg
    this.mode = "idle";      // idle | webrtc | mjpeg
    this.transform = { mirror: false, rotate: 0 };
    this.geometry = { width: config.width, height: config.height };
    this.sourceSize = null;
    this.idleFrame = null;   // hazir bekleme karesi (ham yuv420p)
    this.lastFrame = null;   // son canli kare: kopmada donmus goruntu icin
    this.holdUntil = 0;
    this.lastFrameAt = 0;
    this.tickTimer = null;
    this.queue = Promise.resolve();
    this.lastRtp = null;
    this.stopping = false;
  }

  check() {
    const dev = config.device;
    if (!dev.startsWith("/dev/video")) return { ok: true };
    if (!fs.existsSync(dev)) return { ok: false, reason: `${dev} yok. Once: sudo bash scripts/setup-v4l2.sh` };
    try {
      fs.accessSync(dev, fs.constants.W_OK);
    } catch {
      return { ok: false, reason: `${dev} yazilabilir degil (video grubunda misin?)` };
    }
    return { ok: true };
  }

  #serial(fn) {
    this.queue = this.queue.then(fn, fn);
    return this.queue;
  }

  // ------------------------------------------------------- bekleme karesi --

  /** Bekleme kartini bir kez ham kare olarak uretip saklar. */
  async renderIdleFrame(text = "iPhone bekleniyor") {
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "lavfi", "-i", `color=c=0x0D1117:s=${config.width}x${config.height}`,
      "-vf", idleFilter(text),
      "-frames:v", "1", "-f", "rawvideo", "pipe:1",
    ];
    const chunks = [];
    await new Promise((resolve) => {
      const p = spawn(config.ffmpeg, args, { stdio: ["ignore", "pipe", "ignore"] });
      p.stdout.on("data", (d) => chunks.push(d));
      p.on("exit", resolve);
      p.on("error", resolve);
    });
    const buf = Buffer.concat(chunks);
    if (buf.length === FRAME_BYTES()) this.idleFrame = buf;
    return this.idleFrame;
  }

  // ------------------------------------------------------- kalici yazici --

  /** Cihaza yazan sureci baslatir; olurse kendiliginden geri gelir. */
  async start() {
    if (!this.check().ok) return;
    await this.renderIdleFrame();
    this.#startWriter();
    this.tickTimer = setInterval(() => this.#tick(), TICK_INTERVAL);
  }

  #startWriter() {
    const proc = spawn(config.ffmpeg, [
      "-hide_banner", "-loglevel", config.ffmpegLog, "-nostats",
      "-f", "rawvideo", "-pix_fmt", "yuv420p",
      "-video_size", `${config.width}x${config.height}`,
      "-framerate", String(config.fps),
      "-i", "pipe:0",
      "-fps_mode", "passthrough",
      ...(config.device.startsWith("/dev/video")
        ? ["-f", "v4l2", config.device]
        : config.device === "null" ? ["-f", "null", "-"] : ["-y", config.device]),
    ], { stdio: ["pipe", "ignore", "pipe"] });

    this.writer = proc;
    let stderr = "";
    proc.stdin.on("error", () => {});
    proc.stderr.on("data", (d) => {
      const t = d.toString();
      stderr = (stderr + t).slice(-2000);
      if (config.verbose) process.stderr.write(`[ffmpeg:writer] ${t}`);
    });
    proc.on("error", (err) => this.emit("crash", { mode: "writer", code: -1, stderr: err.message }));
    proc.on("exit", (code, signal) => {
      if (this.writer !== proc) return;
      this.writer = null;
      this.emit("crash", {
        mode: "writer",
        code,
        stderr: `sinyal=${signal} ${stderr.split("\n").filter(Boolean).slice(-3).join(" | ")}`,
      });
      // Kasitli kapatma disinda her durumda geri gel: cihaz asla yazicisiz kalmasin
      if (!this.stopping) setTimeout(() => { if (!this.writer) this.#startWriter(); }, WRITER_RETRY);
    });
  }

  #write(frame) {
    const w = this.writer;
    if (!w?.stdin?.writable) return false;
    if (w.stdin.writableLength > FRAME_BYTES() * 3) return false; // biriktirme
    return w.stdin.write(frame);
  }

  /* Cihaz ASLA karesiz kalmamali: yoksa tarayici kamerayi acar ama goruntu
     alamaz. Kaynak susarsa (telefon arka plana atildi, ekran kilitlendi, ag
     tikandi) son kare tekrarlanir; hic kare gelmediyse bekleme karti yazilir. */
  #tick() {
    const now = Date.now();
    if (now - this.lastFrameAt < SOURCE_SILENT_MS) return; // kaynak zaten besliyor
    const keepLast = this.lastFrame && (this.source || now < this.holdUntil);
    const frame = keepLast ? this.lastFrame : this.idleFrame;
    if (frame) this.#write(frame);
  }

  /** Son bir saniye icinde gercek kare geldi mi? */
  get live() {
    return Date.now() - this.lastFrameAt < 1000;
  }

  // --------------------------------------------------------------- kaynak --

  /** Cozulen ham kareleri kalici yaziciya aktarir, son kareyi saklar. */
  #attach(proc, mode) {
    this.source = proc;
    this.mode = mode;
    this.sourceSize = null;

    const frameBytes = FRAME_BYTES();
    let pending = Buffer.alloc(0);

    proc.stdout.on("data", (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes);
        this.lastFrame = Buffer.from(frame);
        this.lastFrameAt = Date.now();
        this.#write(frame);
        pending = pending.subarray(frameBytes);
      }
    });

    let stderr = "";
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-4000);
      const m = s.match(/Video:.*?, (\d{2,4})x(\d{2,4})/);
      if (m) this.sourceSize = `${m[1]}x${m[2]}`;
      if (config.verbose) process.stderr.write(`[ffmpeg:${mode}] ${s}`);
    });

    proc.on("exit", (code, signal) => {
      if (this.source !== proc) return;
      this.source = null;
      this.mode = "idle";
      if (signal !== "SIGTERM" && signal !== "SIGKILL") {
        this.emit("crash", { mode, code, stderr: stderr.trim() });
      }
      this.emit("changed", this.mode);
    });
    proc.on("error", (err) => this.emit("crash", { mode, code: -1, stderr: err.message }));
    this.emit("changed", this.mode);
  }

  #spawnSource(mode, inputArgs, { stdin = "ignore" } = {}) {
    return spawn(config.ffmpeg, [
      "-hide_banner", "-loglevel", config.ffmpegLog, "-nostats",
      ...inputArgs,
      "-vf", transformFilter(this.transform),
      "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1",
    ], { stdio: [stdin, "pipe", "pipe"] });
  }

  #killSource() {
    const proc = this.source;
    if (!proc) return Promise.resolve();
    this.source = null;
    this.mode = "idle";
    return new Promise((resolve) => {
      const t = setTimeout(() => proc.kill("SIGKILL"), 1500);
      proc.once("exit", () => { clearTimeout(t); resolve(); });
      proc.kill("SIGTERM");
    });
  }

  /** WebRTC yolu: RTP'yi SDP tarifiyle dinleyip ham kareye cevirir. */
  startRtp(args) {
    this.lastRtp = args;
    const { payloadType, encodingName, fmtp } = args;
    return this.#serial(async () => {
      await this.#killSource();
      fs.mkdirSync(config.runDir, { recursive: true });
      const sdpPath = path.join(config.runDir, "stream.sdp");
      fs.writeFileSync(sdpPath, [
        "v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=localCam", "c=IN IP4 127.0.0.1", "t=0 0",
        `m=video ${config.rtpPort} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${encodingName}/90000`,
        ...(fmtp ? [`a=fmtp:${payloadType} ${fmtp}`] : []),
        "",
      ].join("\n"));

      this.#attach(this.#spawnSource("webrtc", [
        "-protocol_whitelist", "file,udp,rtp",
        "-fflags", "nobuffer", "-flags", "low_delay",
        "-probesize", "200000", "-analyzeduration", "2000000",
        "-max_delay", "0", "-reorder_queue_size", "64",
        "-i", sdpPath,
      ]), "webrtc");
    });
  }

  /** Yedek yol: telefon JPEG kareleri yollar. */
  startMjpeg() {
    return this.#serial(async () => {
      await this.#killSource();
      const proc = this.#spawnSource(
        "mjpeg",
        ["-f", "mjpeg", "-use_wallclock_as_timestamps", "1", "-i", "pipe:0"],
        { stdin: "pipe" },
      );
      proc.stdin.on("error", () => {});
      this.#attach(proc, "mjpeg");
      return proc;
    });
  }

  writeFrame(buf) {
    const proc = this.source;
    if (this.mode !== "mjpeg" || !proc?.stdin?.writable) return false;
    return proc.stdin.write(buf);
  }

  /** Yayini birakir. freezeMs boyunca son kare donmus halde tutulur. */
  stopSource({ freezeMs = 0, text = "iPhone bekleniyor" } = {}) {
    return this.#serial(async () => {
      await this.#killSource();
      this.holdUntil = freezeMs > 0 ? Date.now() + freezeMs : 0;
      if (!freezeMs) this.lastFrame = null;
      await this.renderIdleFrame(text);
      this.emit("changed", this.mode);
    });
  }

  async setTransform(next) {
    this.transform = {
      mirror: !!next.mirror,
      rotate: [0, 90, 180, 270].includes(next.rotate) ? next.rotate : 0,
    };
    if (this.mode === "webrtc" && this.lastRtp) return this.startRtp(this.lastRtp);
    if (this.mode === "mjpeg") return this.startMjpeg();
    return null;
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.tickTimer);
    await this.#killSource();
    const w = this.writer;
    this.writer = null;
    if (w) {
      await new Promise((resolve) => {
        const t = setTimeout(() => w.kill("SIGKILL"), 1500);
        w.once("exit", () => { clearTimeout(t); resolve(); });
        w.kill("SIGTERM");
      });
    }
  }
}
