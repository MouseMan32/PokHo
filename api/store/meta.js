import fs from "fs";
import path from "path";

const META_DIR = process.env.META_DIR || "/data/meta";
fs.mkdirSync(META_DIR, { recursive: true });

function fileFor(id) {
  return path.join(META_DIR, `${id}.json`);
}

export function readMeta(id) {
  const p = fileFor(id);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return {}; }
}

export function writeMeta(id, obj) {
  const p = fileFor(id);
  fs.writeFileSync(p, JSON.stringify(obj ?? {}, null, 2));
}
