// api/store/meta.js
import fs from "fs";
import path from "path";

const META_DIR = process.env.META_DIR || "/data/meta";
fs.mkdirSync(META_DIR, { recursive: true });

export function metaPath(id) { return path.join(META_DIR, `${id}.json`); }

export function readMeta(id) {
  const p = metaPath(id);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  return {};
}

export function writeMeta(id, data) {
  fs.writeFileSync(metaPath(id), JSON.stringify(data, null, 2), "utf8");
}
