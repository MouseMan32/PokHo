// api/index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import cors from "cors";

// Gen6 XY parser (namespace import)
import * as XY from "./parsers/gen6_xy.mjs";

// Persisted metadata helpers
import { readMeta, writeMeta } from "./store/meta.js";

/* -----------------------------------------------------------------------------
  App setup
----------------------------------------------------------------------------- */

const app = express();

// CORS (LAN-friendly). Lock down later by setting CORS_ORIGIN.
const CORS_ORIGIN = process.env.CORS_ORIGIN || true;
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

/* -----------------------------------------------------------------------------
  Paths
----------------------------------------------------------------------------- */

const SAVES_DIR = process.env.SAVES_DIR || "/data/saves";
const META_DIR  = process.env.META_DIR  || "/data/meta";
fs.mkdirSync(SAVES_DIR, { recursive: true });
fs.mkdirSync(META_DIR, { recursive: true });

/* -----------------------------------------------------------------------------
  Multer storage -> write directly into /data/saves (avoids EXDEV rename)
----------------------------------------------------------------------------- */

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SAVES_DIR),
  filename: (_req, file, cb) => {
    const safe = String(file.originalname || "upload").replace(/[^\w.\-]+/g, "_");
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safe}`;
    cb(null, id);
  },
});
const upload = multer({ storage });

/* -----------------------------------------------------------------------------
  Small helpers
----------------------------------------------------------------------------- */

function boxesCachePath(id) {
  return path.join(META_DIR, `${id}.boxes.json`);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function fileSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return sha256(buf);
}

function fileSize(filePath) {
  return fs.statSync(filePath).size;
}

/* -----------------------------------------------------------------------------
  Health
----------------------------------------------------------------------------- */

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "openhome-api", time: Date.now() });
});

/* -----------------------------------------------------------------------------
  Saves: list / upload
----------------------------------------------------------------------------- */

// List saves (id + friendly name)
app.get("/api/saves", (_req, res) => {
  const files = fs.readdirSync(SAVES_DIR).filter(f => !f.startsWith("."));
  const items = files.map((id) => {
    const meta = readMeta(id);
    const name = meta?.originalName || id;
    return { id, name };
  });
  // newest first
  items.sort((a, b) => (a.id < b.id ? 1 : -1));
  res.json(items);
});

// Upload (multiple)
app.post("/api/saves", upload.array("files", 16), (req, res) => {
  try {
    if (!req.files?.length) {
      return res.status(400).json({ error: "No files uploaded (form field must be 'files')" });
    }
    const uploaded = [];
    for (const f of /** @type {Express.Multer.File[]} */ (req.files)) {
      const id = path.basename(f.filename);
      const meta = {
        id,
        originalName: f.originalname,
        size: f.size,
        uploadedAt: Date.now(),
      };
      writeMeta(id, meta);
      uploaded.push({ id, name: meta.originalName || id });
    }
    res.json({ uploaded });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* -----------------------------------------------------------------------------
  Validate / Override (simple detector for XY Citra/JKSV 'main')
----------------------------------------------------------------------------- */

// Simple on-box detector for Gen6 XY save
function detectXY(filePath) {
  const size = fileSize(filePath);
  // Citra/JKSV 'main' for XY commonly 0x65600 = 415,232 bytes
  const XY_EXPECTED_SIZE = 0x65600;
  const confidence = size === XY_EXPECTED_SIZE ? 0.98 : 0.5;
  const game = size === XY_EXPECTED_SIZE ? "X/Y (Citra 'main')" : "Gen 6 (guess)";
  return { generation: 6, game, confidence, notes: `size=${size}` };
}

app.post("/api/saves/validate", (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    const filePath = path.join(SAVES_DIR, id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

    const meta = readMeta(id);
    const detection = detectXY(filePath);
    const out = {
      filename: meta?.originalName || id,
      size: fileSize(filePath),
      sha256: fileSha256(filePath),
      detection,
    };
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "validate failed" });
  }
});

// Manual override for game/generation (also useful to stash manual )
app.post("/api/saves/override", (req, res) => {
  try {
    const { id, game, generation, xyRegion } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    const meta = readMeta(id);
    if (!meta || !fs.existsSync(path.join(SAVES_DIR, id))) {
      return res.status(404).json({ error: "Save not found" });
    }
    if (typeof game === "string") meta.game = game;
    if (typeof generation !== "undefined") meta.generation = generation;
    if (typeof xyRegionOffset === "number") meta.xyRegionOffset = xyRegionOffset;
    writeMeta(id, meta);
    res.json({ ok: true, meta });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "override failed" });
  }
});

/* -----------------------------------------------------------------------------
  Boxes (open / export)
----------------------------------------------------------------------------- */

app.get("/api/boxes/:id", (req, res) => {
  try {
    const id = req.params.id;
    const filePath = path.join(SAVES_DIR, id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });
    const buf = fs.readFileSync(filePath);

    const meta = readMeta(id) || {};
    // Use saved offset if present; else pick/refine; else try findBoxRegion
let offset = Number(meta.xyRegionOffset);
const forceRecalc = String(req.query.recalc || "") === "1";

if (!Number.isInteger(offset) || offset < 0 || forceRecalc) {
  // 1) Prefer the new refined picker
  const region = XY.findBoxRegion(buf, null);
  let picked = region?.offset ?? null;

  // 2) Fallback to legacy fast+refine, but with NO hint bias
  if (!Number.isInteger(picked) || picked < 0) {
    const fast = XY.xyAutoPickOffsetFast(buf, 0x0);
    const choice = fast?.best ? XY.refineAround(buf, fast.best.offset) : null;
    picked = choice?.offset ?? null;
  }

  // 3) Last-resort: only if you want a guaranteed non-null during dev
  // (Comment this out for now so we can *see* nulls instead of silently 0x22600)
  // if (!Number.isInteger(picked) || picked < 0) picked = 0x22600;

  offset = picked ?? null;
  meta.xyRegionOffset = offset;
  writeMeta(id, meta);

  console.log(`XY pick for ${id}:`, {
    offset: offset == null ? null : `0x${offset.toString(16)}`,
    source: region?.debug?.source || "unknown",
  });
}



    const boxes = XY.readBoxes(buf, offset);
    const out = {
      game: meta.game || "Gen 6 (XY)",
      generation: meta.generation || 6,
      notes: `offset=0x${offset.toString(16)}`,
      trainer: {}, // (optional) fill later
      boxes,
    };
    // Cache last-read boxes
    fs.writeFileSync(boxesCachePath(id), JSON.stringify(out, null, 2));
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "read boxes failed" });
  }
});

// Export raw .pk6 from a given box/slot
app.get("/api/boxes/:id/export", (req, res) => {
  try {
    const id = req.params.id;
    const b = parseInt(String(req.query.box || "1"), 10);
    const s = parseInt(String(req.query.slot || "1"), 10);
    if (!Number.isFinite(b) || !Number.isFinite(s) || b < 1 || s < 1 || s > XY.XY.SLOTS_PER_BOX) {
      return res.status(400).json({ error: "box/slot invalid" });
    }

    const filePath = path.join(SAVES_DIR, id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });
    const buf = fs.readFileSync(filePath);

    const meta = readMeta(id) || {};
    const offset = Number(meta.xyRegionOffset);
    if (!Number.isInteger(offset)) {
      return res.status(400).json({ error: "No XY offset known. Open boxes first or run autofix." });
    }

    const idx = (b - 1) * XY.XY.SLOTS_PER_BOX + (s - 1);
    const start = offset + idx * XY.XY.SLOT_SIZE;
    const end = start + XY.XY.SLOT_SIZE;
    if (end > buf.length) return res.status(400).json({ error: "Slice out of range" });

    const slice = buf.subarray(start, end);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="box${b}_slot${s}.pk6"`);
    res.end(slice);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "export failed" });
  }
});

/* -----------------------------------------------------------------------------
  XY helpers: manual region, probe, scan, autofix
----------------------------------------------------------------------------- */

// Manually set XY offset (accepts decimal or 0xHEX)
app.post("/api/saves/xy/region", (req, res) => {
  try {
    const { id, offset } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    let off = typeof offset === "string" ? (/^0x/i.test(offset) ? Number(offset) : Number(offset)) : Number(offset);
    if (!Number.isFinite(off) || off < 0) return res.status(400).json({ error: "bad offset" });
    const meta = readMeta(id) || {};
    meta.xyRegionOffset = off;
    writeMeta(id, meta);
    res.json({ ok: true, offset: off });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "set region failed" });
  }
});

// Probe first ~20 slots at a given offset (for quick sanity)
app.get("/api/debug/xy/:id/probe", (req, res) => {
  const id = req.params.id;
  const offStr = String(req.query.offset ?? "");
  const filePath = path.join(SAVES_DIR, id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

  const buf = fs.readFileSync(filePath);

  let base = /^0x/i.test(offStr) ? Number(offStr) : Number(offStr);
  if (!Number.isFinite(base) || base < 0) {
    return res.status(400).json({ error: "Provide ?offset=0xHEX or decimal" });
  }

  const results = [];
  const take = 20;
  for (let i = 0; i < take; i++) {
    const start = base + i * XY.XY.SLOT_SIZE;
    const end = start + XY.XY.SLOT_SIZE;
    if (end > buf.length) break;
    const slice = buf.subarray(start, end);

    // fast zero check
    let nz = false;
    for (let j = 0; j < slice.length; j++) { if (slice[j] !== 0) { nz = true; break; } }
    if (!nz) { results.push({ slot: i + 1, empty: true }); continue; }

    const d = XY.decodeSlot(slice);
    if (!d || d.checksumOK !== true) { results.push({ slot: i + 1, empty: true }); continue; }

    results.push({
      slot: i + 1,
      species: d.species,
      pid: d.pid,
      tid: d.tid,
      sid: d.sid,
      shiny: !!d.shiny,
      checksumOK: true,
    });
  }

  res.json({ offset: base, sampleCount: results.length, slots: results });
});

// Quick scan near a hint (returns top candidates)
app.get("/api/debug/xy/:id/scan", (req, res) => {
  try {
    const id = req.params.id;
    const hintStr = String(req.query.hint ?? "0x22600");
    const filePath = path.join(SAVES_DIR, id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });
    const buf = fs.readFileSync(filePath);

    const hint = /^0x/i.test(hintStr) ? Number(hintStr) : Number(hintStr);
    const fast = XY.xyAutoPickOffsetFast(buf, hint);
    res.json({ ok: true, ...(fast || {}) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "scan failed" });
  }
});

// Autofix offset (coarse + refine) and persist
app.post("/api/saves/xy/autofix", (req, res) => {
  try {
    const { id, hint } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    const filePath = path.join(SAVES_DIR, id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

    const buf = fs.readFileSync(filePath);

    let hintNum = 0x22600;
    if (typeof hint === "string" && hint.length) {
      hintNum = /^0x/i.test(hint) ? Number(hint) : Number(hint);
    } else if (typeof hint === "number") {
      hintNum = hint;
    }

    const fast = XY.xyAutoPickOffsetFast(buf, hintNum);
    const chosen = fast?.best ? XY.refineAround(buf, fast.best.offset) : null;
    if (!chosen) return res.json({ ok: false, reason: "no-candidate" });

    const meta = readMeta(id) || {};
    meta.xyRegionOffset = chosen.offset;
    writeMeta(id, meta);

    res.json({ ok: true, chosen, top: fast.top });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "autofix failed" });
  }
});

/* -----------------------------------------------------------------------------
  Start server
----------------------------------------------------------------------------- */

const PORT = process.env.PORT || 8095;
app.listen(PORT, () => {
  console.log(`openhome-api listening on :${PORT}`);
});
