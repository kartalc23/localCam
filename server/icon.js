import zlib from "node:zlib";

/** Durum renkleri: bagli degil / yayinda / hata */
export const ICON_COLORS = {
  idle: [0xb9, 0xc1, 0xcb],
  live: [0x3f, 0xb9, 0x50],
  error: [0xf8, 0x51, 0x49],
};

const SS = 3; // kenar yumusatma icin ust orneklem

function coverage(cx, cy, size) {
  // Video kamera silueti: yuvarlatilmis govde + saga bakan lens ucgeni
  const bx0 = size * 0.08, bx1 = size * 0.63;
  const by0 = size * 0.28, by1 = size * 0.74;
  const r = size * 0.11;

  const inBody = () => {
    if (cx < bx0 || cx > bx1 || cy < by0 || cy > by1) return false;
    const qx = Math.min(Math.max(cx, bx0 + r), bx1 - r);
    const qy = Math.min(Math.max(cy, by0 + r), by1 - r);
    return (cx - qx) ** 2 + (cy - qy) ** 2 <= r * r;
  };

  const tx0 = size * 0.68, tx1 = size * 0.93;
  const tcy = (by0 + by1) / 2;
  const inLens = () => {
    if (cx < tx0 || cx > tx1) return false;
    const half = ((cx - tx0) / (tx1 - tx0)) * (size * 0.23) + size * 0.05;
    return Math.abs(cy - tcy) <= half;
  };

  return inBody() || inLens();
}

/** RGBA buffer uretir (genislik*yukseklik*4). */
export function drawIcon(size, rgb) {
  const [r, g, b] = rgb;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (coverage(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size)) hits++;
        }
      }
      const a = Math.round((hits / (SS * SS)) * 255);
      const i = (y * size + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }
  }
  return out;
}

/** StatusNotifierItem ARGB32 (big-endian) bekler. */
export function toArgb(rgba) {
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 3];
    out[i + 1] = rgba[i];
    out[i + 2] = rgba[i + 1];
    out[i + 3] = rgba[i + 2];
  }
  return out;
}

// ------------------------------------------------------------- PNG kodlama --

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtre: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit derinligi
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
