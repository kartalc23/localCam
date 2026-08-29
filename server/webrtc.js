import dgram from "node:dgram";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";
import { config } from "./config.js";

const FEEDBACK = [
  { type: "nack" },
  { type: "nack", parameter: "pli" },
  { type: "ccm", parameter: "fir" },
  { type: "goog-remb" },
];

// iPhone'da H.264 donanim encoder'i kullanilir: dusuk gecikme, dusuk pil tuketimi.
const CODECS = [
  new RTCRtpCodecParameters({
    mimeType: "video/H264",
    clockRate: 90000,
    rtcpFeedback: FEEDBACK,
    parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  }),
  new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, rtcpFeedback: FEEDBACK }),
];

const PLI_SCHEDULE = [0, 300, 800, 1600, 3000];

/**
 * Telefondan gelen WebRTC video track'ini alir, RTP paketlerini
 * ffmpeg'in dinledigi yerel UDP portuna aynen aktarir.
 */
export class WebRtcReceiver {
  constructor(sink, log = () => {}) {
    this.sink = sink;
    this.log = log;
    this.pc = null;
    this.udp = null;
    this.timers = [];
    this.stats = { packets: 0, bytes: 0, since: 0, codec: null };
    this.transceiver = null;
    this.ssrc = null;
    this.onEnd = () => {};
  }

  get active() {
    return !!this.pc;
  }

  async handleOffer(offerSdp, sendIce) {
    await this.close();

    const pc = new RTCPeerConnection({
      codecs: { video: CODECS },
      iceServers: [],
      icePortRange: config.icePortRange,
    });
    this.pc = pc;

    const transceiver = pc.addTransceiver("video", { direction: "recvonly" });

    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) sendIce(candidate.toJSON ? candidate.toJSON() : candidate);
    });

    pc.connectionStateChange.subscribe((state) => {
      this.log(`webrtc durumu: ${state}`);
      if (state === "failed" || state === "closed" || state === "disconnected") {
        this.close().then(() => this.onEnd(state));
      }
    });

    transceiver.onTrack.subscribe((track) => this.#attachTrack(track, transceiver));

    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return pc.localDescription.sdp;
  }

  async addIceCandidate(candidate) {
    if (this.pc && candidate) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        this.log(`ice adayi reddedildi: ${err.message}`);
      }
    }
  }

  /** ffmpeg yeniden baslatildiginda telefondan taze keyframe iste. */
  requestKeyframe() {
    for (const delay of PLI_SCHEDULE) {
      this.timers.push(
        setTimeout(() => {
          if (this.ssrc !== null && this.pc && this.transceiver) {
            try { this.transceiver.receiver.sendRtcpPLI(this.ssrc); } catch { /* kapanmis */ }
          }
        }, delay),
      );
    }
  }

  #attachTrack(track, transceiver) {
    const codec = track.codec;
    const encodingName = (codec?.mimeType || "video/H264").split("/")[1];
    const payloadType = codec?.payloadType ?? 96;
    this.stats = { packets: 0, bytes: 0, since: Date.now(), codec: encodingName };
    this.transceiver = transceiver;
    this.log(`track alindi: ${encodingName} pt=${payloadType}`);

    const udp = dgram.createSocket("udp4");
    udp.on("error", (err) => this.log(`udp hatasi: ${err.message}`));
    this.udp = udp;

    let ready = false;

    // ffmpeg UDP portunu baglayana kadar gelen paketleri atiyoruz;
    // sonrasinda PLI ile telefondan taze bir keyframe istiyoruz.
    this.sink
      .startRtp({ payloadType, encodingName, fmtp: codec?.parameters || undefined })
      .then(() => {
        ready = true;
        this.requestKeyframe();
      });

    track.onReceiveRtp.subscribe((rtp) => {
      if (this.ssrc === null) this.ssrc = rtp.header.ssrc;
      if (!ready || !this.udp) return;
      const buf = rtp.serialize();
      this.stats.packets++;
      this.stats.bytes += buf.length;
      udp.send(buf, config.rtpPort, "127.0.0.1", (err) => {
        if (err) this.log(`udp gonderim hatasi: ${err.message}`);
      });
    });
  }

  async close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.transceiver = null;
    this.ssrc = null;
    if (this.udp) {
      try { this.udp.close(); } catch { /* zaten kapali */ }
      this.udp = null;
    }
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      try { await pc.close(); } catch { /* zaten kapali */ }
    }
  }
}
