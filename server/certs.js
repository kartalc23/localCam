import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "./config.js";
import { lanAddresses, mdnsHost } from "./net.js";

const sh = (args, opts = {}) =>
  execFileSync("openssl", args, { stdio: ["ignore", "pipe", "pipe"], ...opts }).toString();

function sanList() {
  const dns = new Set(["localhost", mdnsHost()]);
  const ips = new Set(["127.0.0.1", ...lanAddresses().map((a) => a.address)]);
  return [...[...dns].map((d) => `DNS:${d}`), ...[...ips].map((i) => `IP:${i}`)];
}

function currentSans(crt) {
  try {
    const txt = sh(["x509", "-in", crt, "-noout", "-ext", "subjectAltName"]);
    return txt
      .split(/[\n,]/)
      .map((s) => s.trim().replace(/^IP Address:/, "IP:").replace(/^DNS:/, "DNS:"))
      .filter((s) => /^(DNS|IP):/.test(s));
  } catch {
    return [];
  }
}

function ensureCa(dir) {
  const key = path.join(dir, "ca.key");
  const crt = path.join(dir, "ca.crt");
  if (fs.existsSync(key) && fs.existsSync(crt)) return { key, crt, created: false };

  sh([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", crt,
    "-days", "3650", "-sha256",
    "-subj", "/O=localCam/CN=localCam Local CA",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  fs.chmodSync(key, 0o600);
  return { key, crt, created: true };
}

/**
 * Yerel bir CA ve onun imzaladigi sunucu sertifikasini hazirlar.
 * IP degisirse (DHCP) sertifika otomatik yeniden uretilir.
 * CA'yi iPhone'a bir kez kurunca Safari uyari vermez.
 */
export function ensureCertificates() {
  const dir = config.certDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const ca = ensureCa(dir);
  const key = path.join(dir, "server.key");
  const crt = path.join(dir, "server.crt");
  const want = sanList();

  const have = currentSans(crt);
  const covered = fs.existsSync(key) && want.every((s) => have.includes(s));
  let regenerated = false;

  if (!covered) {
    const csr = path.join(dir, "server.csr");
    const ext = path.join(dir, "server.ext");
    fs.writeFileSync(
      ext,
      [
        "basicConstraints=CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=${want.join(",")}`,
        "",
      ].join("\n"),
    );
    sh(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/O=localCam/CN=localCam"]);
    // iOS/Safari 398 gunden uzun omurlu sunucu sertifikalarina guvenmez.
    sh([
      "x509", "-req", "-in", csr, "-CA", ca.crt, "-CAkey", ca.key, "-CAcreateserial",
      "-out", crt, "-days", "397", "-sha256", "-extfile", ext,
    ]);
    fs.chmodSync(key, 0o600);
    fs.rmSync(csr, { force: true });
    fs.rmSync(ext, { force: true });
    regenerated = true;
  }

  return {
    key: fs.readFileSync(key),
    cert: fs.readFileSync(crt),
    caPath: ca.crt,
    caCreated: ca.created,
    regenerated,
    sans: want,
  };
}
