/* localCam - iPhone tarafi. Kamerayi yakalar, WebRTC (veya yedek olarak MJPEG)
   ile ayni WiFi'daki Linux sunucusuna gonderir. */

const $ = (id) => document.getElementById(id);
const els = {
  video: $("preview"), start: $("startBtn"), camera: $("cameraSel"), res: $("resSel"),
  mode: $("modeSel"), mirror: $("mirrorBtn"), rotate: $("rotateBtn"),
  dot: $("dot"), status: $("statusText"), stats: $("statsPill"), error: $("error"),
};

const S = {
  ws: null, pc: null, stream: null, streaming: false, wakeLock: null,
  desired: false, starting: false,
  mirror: false, rotate: 0, mjpegTimer: null, statsTimer: null,
  reconnectDelay: 500, lastBytes: 0, lastAt: 0, mjpegFrames: 0,
};

const BITRATE = {
  "1440x1080": 5_000_000, "1920x1080": 5_000_000,
  "1280x960": 3_500_000, "1280x720": 3_000_000, "960x540": 1_800_000,
};

// ------------------------------------------------------------- ayar hafizasi --

const PREFS = "localcam.prefs";
const PREFS_VERSION = 3; // 3: varsayilan 4:3 genis aciya tasindi (iPhone sensoru 4:3)

function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS) || "{}"); } catch { /* bozuk kayit */ }
  // Surum atlayinca kaydedilmis cozunurluk bir kez yok sayilir, yeni varsayilan gecer
  const fresh = p.v !== PREFS_VERSION;
  if (!fresh && p.res && [...els.res.options].some((o) => o.value === p.res)) els.res.value = p.res;
  if (p.mode) els.mode.value = p.mode;
  S.mirror = !!p.mirror;
  S.rotate = Number(p.rotate) || 0;
  S.auto = p.auto !== false; // varsayilan acik: uygulamayi acinca yayina gecsin
  els.mirror.setAttribute("aria-pressed", String(S.mirror));
  els.video.classList.toggle("mirror", S.mirror);
  els.rotate.textContent = `${S.rotate}\u00b0`;
  els.auto.setAttribute("aria-pressed", String(S.auto));
  els.auto.textContent = S.auto ? "Acik" : "Kapali";
  if (fresh) savePrefs();
  return p;
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS, JSON.stringify({
      res: els.res.value, mode: els.mode.value, camera: els.camera.value,
      v: PREFS_VERSION,
      mirror: S.mirror, rotate: S.rotate, auto: S.auto,
    }));
  } catch { /* ozel mod olabilir */ }
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.dot.className = `dot ${kind}`;
}
function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = !msg;
}

// ------------------------------------------------------------- WebSocket --

function connect() {
  if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(`wss://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  S.ws = ws;

  ws.onopen = () => {
    S.reconnectDelay = 500;
    if (!S.streaming) setStatus("sunucuya baglandi");
    sendTransform();
  };
  ws.onclose = () => {
    setStatus("sunucu baglantisi yok", "bad");
    if (S.streaming) stopStreaming({ keepCamera: true, user: false });
    setTimeout(connect, S.reconnectDelay);
    S.reconnectDelay = Math.min(S.reconnectDelay * 2, 8000);
  };
  ws.onerror = () => setStatus("baglanti hatasi", "bad");
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
}

function send(obj) {
  if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

async function handleMessage(msg) {
  switch (msg.t) {
    case "answer":
      await S.pc?.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      break;
    case "ice":
      try { await S.pc?.addIceCandidate(msg.candidate); } catch { /* gec gelen aday */ }
      break;
    case "ready":
      setStatus(msg.mode === "webrtc" ? "yayinda - H.264" : "yayinda - MJPEG", "live");
      showError("");
      break;
    case "error":
      showError(msg.message);
      setStatus("hata", "bad");
      break;
    case "taken-over":
      showError("Baska bir cihaz yayini devraldi.");
      stopStreaming({ user: true });
      break;
  }
}

// ---------------------------------------------------------------- kamera --

async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput" && d.label);
    if (cams.length < 2) return;
    const current = els.camera.value;
    els.camera.innerHTML = "";
    for (const c of cams) {
      const o = document.createElement("option");
      o.value = c.deviceId;
      o.textContent = c.label.replace(/\s*camera\s*/i, "").trim() || "Kamera";
      els.camera.appendChild(o);
    }
    if ([...els.camera.options].some((o) => o.value === current)) els.camera.value = current;
  } catch { /* izin yoksa etiketler bos gelir */ }
}

async function openCamera() {
  const [w, h] = els.res.value.split("x").map(Number);
  const sel = els.camera.value;
  const video = {
    width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 },
    ...(sel === "user" || sel === "environment"
      ? { facingMode: { ideal: sel } }
      : { deviceId: { exact: sel } }),
  };

  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  els.video.srcObject = S.stream;
  await els.video.play().catch(() => {});
  await listCameras();
  return S.stream;
}

// ---------------------------------------------------------------- WebRTC --

async function startWebRtc(stream) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  S.pc = pc;

  pc.onicecandidate = (e) => { if (e.candidate) send({ t: "ice", candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected"].includes(pc.connectionState) && S.streaming) {
      showError("WebRTC baglantisi koptu. MJPEG yedegini deneyebilirsin.");
      setStatus("baglanti koptu", "bad");
    }
  };

  const track = stream.getVideoTracks()[0];
  const sender = pc.addTrack(track, stream);

  try {
    const params = sender.getParameters();
    // Var olan encoding'i degistir: diziyi komple degistirmek Safari'de
    // olceklendirme ayarlarini sifirliyor
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = BITRATE[els.res.value] || 3_000_000;
    params.encodings[0].scaleResolutionDownBy = 1;
    params.degradationPreference = "maintain-resolution";
    await sender.setParameters(params);
  } catch { /* Safari bazi surumlerde reddediyor, kritik degil */ }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ t: "offer", sdp: pc.localDescription.sdp });
}

// ----------------------------------------------------------------- MJPEG --

function startMjpeg(stream) {
  send({ t: "mjpeg-start" });

  const track = stream.getVideoTracks()[0];
  const { width = 1280, height = 720, frameRate = 24 } = track.getSettings();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  const interval = 1000 / Math.min(frameRate || 24, 24);
  S.mjpegFrames = 0;

  const tick = () => {
    if (!S.streaming) return;
    S.mjpegTimer = setTimeout(tick, interval);
    if (S.ws?.readyState !== WebSocket.OPEN || S.ws.bufferedAmount > 512 * 1024) return;
    ctx.drawImage(els.video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (blob && S.streaming && S.ws?.readyState === WebSocket.OPEN) {
          blob.arrayBuffer().then((b) => {
            S.ws.send(b);
            S.mjpegFrames++;
            S.lastBytes += b.byteLength;
          });
        }
      },
      "image/jpeg",
      0.72,
    );
  };
  tick();
}

// ------------------------------------------------------------ baslat/dur --

async function startStreaming({ user = true } = {}) {
  if (S.starting || S.streaming) return;
  S.starting = true;
  if (user) S.desired = true;
  showError("");
  setStatus("kamera aciliyor...", "warn");
  els.start.disabled = true;
  try {
    const stream = await openCamera();
    connect();
    await waitForSocket();

    S.streaming = true;
    S.lastBytes = 0;
    S.lastAt = performance.now();

    // iOS kamerayi arka planda kapatirsa denetci yeniden baslatsin
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      S.streaming = false;
      setStatus("kamera durdu, yeniden baglaniyor", "warn");
    });

    if (els.mode.value === "webrtc") await startWebRtc(stream);
    else startMjpeg(stream);

    els.start.textContent = "Yayini durdur";
    els.start.classList.add("live");
    els.stats.hidden = false;
    S.statsTimer = setInterval(updateStats, 1000);
    await requestWakeLock();
  } catch (err) {
    // Izin reddedildiyse denetci bosuna donmesin, kullanici tekrar bassin
    if (err.name === "NotAllowedError") S.desired = false;
    showError(cameraErrorText(err));
    setStatus("baslatilamadi", "bad");
    S.streaming = false;
  } finally {
    S.starting = false;
    els.start.disabled = false;
  }
}

function stopStreaming({ keepCamera = false, user = true } = {}) {
  S.streaming = false;
  if (user) S.desired = false;
  clearTimeout(S.mjpegTimer);
  clearInterval(S.statsTimer);
  S.pc?.close();
  S.pc = null;
  send({ t: "stop" });
  if (!keepCamera) {
    S.stream?.getTracks().forEach((t) => t.stop());
    S.stream = null;
    els.video.srcObject = null;
  }
  releaseWakeLock();
  els.start.textContent = "Yayini baslat";
  els.start.classList.remove("live");
  els.stats.hidden = true;
  setStatus(S.desired ? "yeniden baglaniyor" : "durduruldu", S.desired ? "warn" : "");
}

function waitForSocket() {
  return new Promise((resolve, reject) => {
    if (S.ws?.readyState === WebSocket.OPEN) return resolve();
    const t = setTimeout(() => reject(new Error("Sunucuya baglanilamadi.")), 5000);
    const check = setInterval(() => {
      if (S.ws?.readyState === WebSocket.OPEN) {
        clearTimeout(t); clearInterval(check); resolve();
      }
    }, 100);
  });
}

function cameraErrorText(err) {
  if (err.name === "NotAllowedError") return "Kamera izni reddedildi. Ayarlar > Safari > Kamera izninden ac.";
  if (err.name === "NotFoundError") return "Kamera bulunamadi.";
  if (err.name === "OverconstrainedError") return "Bu cozunurluk desteklenmiyor, daha dusugunu sec.";
  return err.message || String(err);
}

// -------------------------------------------------------------- istatistik --

async function updateStats() {
  let line = "";
  if (S.pc) {
    const stats = await S.pc.getStats();
    let report = null;
    let pair = null;
    stats.forEach((r) => {
      if (r.type === "candidate-pair" && r.state === "succeeded") pair = r;
      if (r.type === "outbound-rtp" && r.kind === "video") {
        report = r;
        const now = performance.now();
        const kbps = Math.round(((r.bytesSent - S.lastBytes) * 8) / (now - S.lastAt));
        S.lastBytes = r.bytesSent;
        S.lastAt = now;
        line = `${r.frameWidth || "?"}x${r.frameHeight || "?"} ${Math.round(r.framesPerSecond || 0)}fps ${kbps}kbps`;
      }
    });
    // Sunucu tarafinda teshis edebilmek icin telefonun kendi gordugu rakamlar
    const track = S.stream?.getVideoTracks?.()[0];
    send({
      t: "stats",
      stats: {
        gonderilenKare: report?.framesSent ?? null,
        kodlananKare: report?.framesEncoded ?? null,
        bayt: report?.bytesSent ?? null,
        genislik: report?.frameWidth ?? null,
        yukseklik: report?.frameHeight ?? null,
        fps: report?.framesPerSecond ?? null,
        kaliteSiniri: report?.qualityLimitationReason ?? null,
        pcDurum: S.pc?.connectionState ?? null,
        iceDurum: S.pc?.iceConnectionState ?? null,
        adayCifti: pair ? `${pair.localCandidateId}->${pair.remoteCandidateId}` : null,
        kameraDurum: track ? `${track.readyState}${track.muted ? " (muted)" : ""}` : "yok",
        kameraAyar: track ? JSON.stringify(track.getSettings()) : null,
        wakeLockDestegi: "wakeLock" in navigator,
        wakeLockTutuluyor: !!S.wakeLock && !S.wakeLock.released,
        sayfaGorunur: document.visibilityState,
        ekranAcikSure: Math.round(performance.now() / 1000),
      },
    });
  } else if (S.streaming) {
    const now = performance.now();
    const kbps = Math.round((S.lastBytes * 8) / (now - S.lastAt));
    line = `${S.mjpegFrames}f ${kbps}kbps`;
    S.mjpegFrames = 0;
    S.lastBytes = 0;
    S.lastAt = now;
  }
  els.stats.textContent = line;
  els.stats.hidden = !line;
}

// ---------------------------------------------------------------- wakelock --

async function requestWakeLock() {
  try {
    S.wakeLock = await navigator.wakeLock?.request("screen");
  } catch { /* desteklenmiyorsa ekran sonebilir */ }
}
function releaseWakeLock() {
  S.wakeLock?.release().catch(() => {});
  S.wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (S.streaming) requestWakeLock();
  supervise();
});

// Safari sayfayi geri yuklerse (kilit ekranindan donus) hemen toparla
window.addEventListener("pageshow", () => supervise());
window.addEventListener("online", () => { connect(); supervise(); });

/** Yayinda olmasi gerekiyorsa ve degilse, sessizce yeniden baslat. */
function supervise() {
  if (!S.desired || S.streaming || S.starting) return;
  if (document.visibilityState !== "visible") return;
  connect();
  startStreaming({ user: false }).catch(() => {});
}

setInterval(supervise, 2000);

// ------------------------------------------------------------------ olaylar --

function sendTransform() {
  send({ t: "transform", mirror: S.mirror, rotate: S.rotate });
}

/** Dikey tutuldugunda kullaniciyi uyar: yatay tutarsa kare tam dolar. */
els.start.addEventListener("click", () => (S.streaming ? stopStreaming() : startStreaming()));

els.auto.addEventListener("click", () => {
  S.auto = !S.auto;
  els.auto.setAttribute("aria-pressed", String(S.auto));
  els.auto.textContent = S.auto ? "Acik" : "Kapali";
  savePrefs();
});

els.mirror.addEventListener("click", () => {
  S.mirror = !S.mirror;
  els.mirror.setAttribute("aria-pressed", String(S.mirror));
  els.video.classList.toggle("mirror", S.mirror);
  savePrefs();
  sendTransform();
});

els.rotate.addEventListener("click", () => {
  S.rotate = (S.rotate + 90) % 360;
  els.rotate.textContent = `${S.rotate}°`;
  savePrefs();
  sendTransform();
});

for (const el of [els.camera, els.res, els.mode]) {
  el.addEventListener("change", async () => {
    savePrefs();
    if (!S.streaming) {
      if (el !== els.mode) await openCamera().catch((e) => showError(cameraErrorText(e)));
      return;
    }
    stopStreaming();
    setTimeout(startStreaming, 300); // ayar degisince yayini yeniden kur
  });
}


const prefs = loadPrefs();
connect();
setStatus("hazir");

// "Acilista otomatik baslat" acikken tek dokunus bile gerekmeden yayina gecmeyi dene.
// iOS kullanici hareketi isterse buton gorunur kalir ve uyari yazariz.
if (S.auto) {
  const kick = () => startStreaming().catch(() => {});
  if (document.readyState === "complete") setTimeout(kick, 250);
  else window.addEventListener("load", () => setTimeout(kick, 250), { once: true });
}

if (prefs.camera) {
  els.camera.value = prefs.camera;
  if (!els.camera.value) els.camera.value = "environment";
}
