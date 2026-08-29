import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";

import { config } from "./config.js";
import { ensureCertificates } from "./certs.js";
import { lanAddresses, mdnsHost } from "./net.js";
import { serveStatic } from "./static.js";
import { V4L2Sink } from "./sink.js";
import { WebRtcReceiver } from "./webrtc.js";
import { Tray } from "./tray.js";

const log = (...a) => console.log("[localCam]", ...a);

const sink = new V4L2Sink();
const rtc = new WebRtcReceiver(sink, (m) => config.verbose && log(m));

let publisher = null; // aktif telefon baglantisi
let publisherMode = null;
let lastError = null;
let phoneStats = null; // telefonun kendi bildirdigi gonderim istatistikleri
let frames = 0;
let framesBytes = 0;
// Telefon kisa sureligine kopunca (ekran kilidi, WiFi gecisi) hemen "bekleniyor"
// kartina dusme: ffmpeg'i calisir birak, tuketiciler son kareyi donmus gorsun.
const RECONNECT_GRACE_MS = 12000;

const certs = ensureCertificates();
const phoneUrl = () => {
  const ip = lanAddresses()[0]?.address || "127.0.0.1";
  return `https://${ip}:${config.httpsPort}/`;
};
const desktopUrl = () => `http://127.0.0.1:${config.httpPort}/desktop`;

// ------------------------------------------------------------------ tray --

const tray = new Tray({
  onActivate: () => detach("xdg-open", [desktopUrl()]),
  onCopy: () => {
    const p = spawn("wl-copy", [phoneUrl()], { stdio: "ignore", detached: true });
    p.on("error", () => detach("xclip", ["-selection", "clipboard"]));
    p.unref();
  },
  onStop: () => goIdle("elle durduruldu"),
  onQuit: () => shutdown(),
});

function detach(cmd, args) {
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch { /* komut yoksa sessiz gec */ }
}

function notify(title, body) {
  detach("notify-send", ["-a", "localCam", "-i", "camera-web", title, body]);
}

function syncTray() {
  if (lastError) return tray.setState("error", lastError);
  if (publisher) {
    const mode = publisherMode === "webrtc" ? "H.264" : "MJPEG";
    return tray.setState("live", `yayinda (${mode}) - ${sink.geometry.width}x${sink.geometry.height}`);
  }
  const check = sink.check();
  tray.setState(check.ok ? "idle" : "error", check.ok ? "iPhone bekleniyor" : check.reason);
}

// ------------------------------------------------------------- yayin akisi --

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

async function goIdle(reason = "iPhone bekleniyor", { grace = 0 } = {}) {
  const had = !!publisher;
  publisher = null;
  publisherMode = null;
  await rtc.close();
  await sink.stopSource({ freezeMs: grace, text: reason });
  syncTray();
  if (had) notify("localCam", "Telefon yayini durdu");
}

async function takeOver(ws) {
  if (publisher && publisher !== ws) {
    send(publisher, { t: "taken-over" });
    try { publisher.close(); } catch { /* zaten kapali */ }
    await rtc.close();
    await sink.stop();
  }
  publisher = ws;
  lastError = null;
}

sink.on("crash", ({ mode, code, stderr }) => {
  const detail = stderr.split("\n").filter(Boolean).pop() || `cikis kodu ${code}`;
  log(`ffmpeg (${mode}) durdu: ${detail}`);
  if (mode === "writer") return; // kendi kendine yeniden baslar (yukarida loglandi)
  send(publisher, { t: "error", message: `ffmpeg durdu: ${detail}` });
  lastError = detail;
  syncTray();
  goIdle("yayin koptu");
});

// --------------------------------------------------------------- HTTP(S) --

function statusJson() {
  return JSON.stringify({
    device: config.device,
    deviceReady: sink.check().ok,
    sinkMode: sink.mode,
    connected: !!publisher,
    publisherMode,
    resolution: `${sink.geometry.width}x${sink.geometry.height}@${config.fps}`,
    sourceResolution: sink.sourceSize,
    receivingFrames: sink.live,
    transform: sink.transform,
    webrtc: { ...rtc.stats, state: rtc.state },
    phone: phoneStats,
    mjpeg: { frames, bytes: framesBytes },
    phoneUrl: phoneUrl(),
    mdnsUrl: `https://${mdnsHost()}:${config.httpsPort}/`,
    addresses: lanAddresses(),
    error: lastError,
  });
}

async function commonRoutes(req, res) {
  const path = req.url.split("?")[0];

  if (path === "/localcam-ca.crt") {
    res.writeHead(200, {
      "content-type": "application/x-x509-ca-cert",
      "content-disposition": 'attachment; filename="localCam-CA.crt"',
    });
    fs.createReadStream(certs.caPath).pipe(res);
    return true;
  }
  if (path === "/status") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(statusJson());
    return true;
  }
  if (path === "/qr.png") {
    const png = await QRCode.toBuffer(phoneUrl(), { width: 512, margin: 2 });
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    res.end(png);
    return true;
  }
  if (path === "/desktop") {
    req.url = "/desktop.html";
    return serveStatic(config.publicDir, req, res);
  }
  return false;
}

const httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, async (req, res) => {
  if (await commonRoutes(req, res)) return;
  if (!serveStatic(config.publicDir, req, res)) res.writeHead(404).end("not found");
});

// Masaustu sayfasi sertifika uyarisi cikarmasin diye duz HTTP'den servis edilir;
// telefon arayuzu ise kamera izni icin HTTPS'e yonlendirilir.
const httpServer = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/desktop" || path.startsWith("/desktop.") || path.endsWith(".png") || path === "/status" ||
      path === "/qr.png" || path === "/localcam-ca.crt" || path === "/style.css") {
    if (await commonRoutes(req, res)) return;
    if (serveStatic(config.publicDir, req, res)) return;
  }
  const host = (req.headers.host || "").split(":")[0];
  res.writeHead(302, { location: `https://${host}:${config.httpsPort}${req.url}` });
  res.end();
});

// ------------------------------------------------------------- WebSocket --

const wss = new WebSocketServer({ server: httpsServer, path: "/ws" });

let wsSeq = 0;

wss.on("connection", (ws, req) => {
  ws.id = ++wsSeq;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  log(`ws#${ws.id} baglandi (${req.socket.remoteAddress})`);
  send(ws, { t: "hello", resolution: { width: config.width, height: config.height, fps: config.fps } });

  ws.on("message", async (data, isBinary) => {
    if (isBinary) {
      if (ws !== publisher || publisherMode !== "mjpeg") return;
      frames++;
      framesBytes += data.length;
      sink.writeFrame(data);
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    try {
      switch (msg.t) {
        case "offer": {
          const check = sink.check();
          if (!check.ok) return send(ws, { t: "error", message: check.reason });
          await takeOver(ws);
          publisherMode = "webrtc";
          phoneStats = null;
          rtc.onEnd = () => {
            if (publisher === ws) goIdle("baglanti bekleniyor", { grace: RECONNECT_GRACE_MS });
          };
          const answer = await rtc.handleOffer(msg.sdp, (c) => send(ws, { t: "ice", candidate: c }));
          send(ws, { t: "answer", sdp: answer });
          send(ws, { t: "ready", mode: "webrtc" });
          log(`ws#${ws.id} WebRTC yayini basladi`);
          syncTray();
          notify("localCam", "iPhone bagli - H.264");
          break;
        }
        case "ice":
          await rtc.addIceCandidate(msg.candidate);
          break;
        case "mjpeg-start": {
          const check = sink.check();
          if (!check.ok) return send(ws, { t: "error", message: check.reason });
          await takeOver(ws);
          publisherMode = "mjpeg";
          frames = 0;
          framesBytes = 0;
          await sink.startMjpeg();
          send(ws, { t: "ready", mode: "mjpeg" });
          log("MJPEG yayini basladi");
          syncTray();
          notify("localCam", "iPhone bagli - MJPEG");
          break;
        }
        case "transform":
          await sink.setTransform({
            mirror: !!msg.mirror,
            rotate: Number(msg.rotate) || 0,
            fill: msg.fill !== false,
          });
          if (publisherMode === "webrtc") rtc.requestKeyframe();
          send(ws, { t: "transform", ...sink.transform });
          break;
        case "stop":
          if (ws === publisher) await goIdle();
          break;
        case "stats":
          if (ws === publisher) phoneStats = { ...msg.stats, at: new Date().toISOString() };
          break;
        case "ping":
          send(ws, { t: "pong", sinkMode: sink.mode });
          break;
      }
    } catch (err) {
      log(`hata: ${err.stack || err.message}`);
      send(ws, { t: "error", message: err.message });
    }
  });

  ws.on("close", (code, reason) => {
    log(`ws#${ws.id} kapandi (kod=${code}${reason?.length ? ` ${reason}` : ""}${ws === publisher ? ", yayinciydi" : ""})`);
    // Kullanici durdurmadiysa kisa bir tolerans taniyip donmus kareyi koru.
    if (ws === publisher) goIdle("baglanti bekleniyor", { grace: RECONNECT_GRACE_MS });
  });

  ws.on("error", (err) => log(`ws#${ws.id} hata: ${err.message}`));
});

// ffmpeg cozmeye baslayana kadar anahtar kare istemeyi birakma: IDR gelmeden
// tek bir kare bile uretilemez ve kamera bos gorunur.
const keyframeWatch = setInterval(() => {
  if (publisherMode === "webrtc" && sink.mode === "webrtc" && !sink.live) rtc.requestKeyframe();
}, 1000);

// Bosta kalan baglantiyi ag ekipmanlari dusurmesin; olen baglantiyi da temizler.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      log(`ws#${ws.id} yanit vermiyor, kapatiliyor`);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

// ------------------------------------------------------------------ boot --

async function banner() {
  const ips = lanAddresses();
  const url = phoneUrl();
  console.log("");
  console.log(await QRCode.toString(url, { type: "terminal", small: true }));
  console.log(`  iPhone'da ac:  ${url}`);
  console.log(`  alternatif:    https://${mdnsHost()}:${config.httpsPort}/`);
  for (const ip of ips.slice(1)) console.log(`                 https://${ip.address}:${config.httpsPort}/`);
  console.log(`  sertifika:     ${url}localcam-ca.crt  (bir kez kur, uyari kalksin)`);
  console.log(`  masaustu:      ${desktopUrl()}`);
  console.log(`  sanal kamera:  ${config.device}  ${config.width}x${config.height}@${config.fps}`);
  console.log("");
}

async function shutdown() {
  log("kapatiliyor...");
  clearInterval(heartbeat);
  clearInterval(keyframeWatch);
  await rtc.close();
  await sink.stop();
  await tray.stop();
  process.exit(0);
}

const check = sink.check();
if (!check.ok) log(`UYARI: ${check.reason}`);
else await sink.start();

if (certs.regenerated) log("sunucu sertifikasi guncellendi (IP degismis olabilir)");

await tray.start().catch((err) => log(`tray baslatilamadi: ${err.message}`));
syncTray();

httpsServer.listen(config.httpsPort, () => {
  httpServer.listen(config.httpPort);
  banner();
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, shutdown);
