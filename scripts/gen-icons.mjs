/* PWA ve masaustu icin ikon dosyalarini uretir: node scripts/gen-icons.mjs */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drawIcon, encodePng, ICON_COLORS } from "../server/icon.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
for (const size of [180, 192, 512]) {
  fs.writeFileSync(path.join(dir, `icon-${size}.png`), encodePng(drawIcon(size, ICON_COLORS.live), size));
}
fs.writeFileSync(path.join(dir, "favicon.png"), encodePng(drawIcon(64, ICON_COLORS.live), 64));
console.log("ikonlar uretildi:", dir);
