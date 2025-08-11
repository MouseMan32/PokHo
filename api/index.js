// api/index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import cors from "cors";
import * as XY from "./parsers/gen6_xy.mjs";
import { readMeta, writeMeta } from "./store/meta.js";

import { detectFormat } from "./parsers/detect.mjs";
import {
  isLikelyXYSav,
  readMetadata as xyReadMeta, // placeholder currently
  readBoxes as xyReadBoxes,
  findBoxRegion,
  XY,
  xyAutoPickOffsetFast,
} from "./parsers/gen6_xy.mjs";

/* -----------------------------------------------------------------------------
  App setup
----------------------------------------------------------------------------- */

const app = express();

// CORS: reflect any origin (handy for LAN use). Lock down later if you prefer.
app.use(cors({ origin: true }));
app.use(express.json());

/* -----------------------------------------------------------------------------
  Paths
----------------------------------------------------------------------------- */

const SAVES_DIR = process.env.SAVES_DIR || "/data/saves";
const META_DIR  = process.env.META_DIR  || "/data/meta";
fs.mkdirSync(SAVES_DIR, { recursive: true });
fs.mkdirSync(META_DIR, { recursive: true });

/* -----------------------------------------------------------------------------
  Multer storage: write uploaded files directly into /data/saves
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
  Tiny persistence helpers (meta + boxes cache)
----------------------------------------------------------------------------- */

function metaPath(id)       { return path.join(META_DIR, `${id}.json`); }
function boxesCachePath(id) { return path.join(META_DIR, `${id}.boxes.json`); }

function readMeta(id) {
  const p = metaPath(id);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}
function writeMeta(id, obj) {
  fs.writeFileSync(metaPath(id), JSON.stringify(obj ?? {}, null, 2));
}

function readBoxesCache(id) {
  const p = boxesCachePath(id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function writeBoxesCache(id, payloadWithSha) {
  try { fs.writeFileSync(boxesCachePath(id), JSON.stringify(payloadWithSha, null, 2)); } catch {}
}

/* -----------------------------------------------------------------------------
  Health
----------------------------------------------------------------------------- */

app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* -----------------------------------------------------------------------------
  Saves: list + upload
----------------------------------------------------------------------------- */

app.get("/api/saves", (_req, res) => {
  const files = fs.readdirSync(SAVES_DIR);
  const list = files.map((f) => ({
    id: f,
    name: f.split("-").slice(2).join("-") || f,
  }));
  res.json(list);
});

app.post("/api/saves", upload.array("files"), (req, res) => {
  const uploaded = (req.files || []).map((f) => ({ id: f.filename, name: f.originalname }));
  res.status(201).json({ uploaded });
});

/* -----------------------------------------------------------------------------
  Manual override (game/gen) + XY offset set
----------------------------------------------------------------------------- */

app.post("/api/saves/override", (req, res) => {
  const { id, game, generation } = req.body || {};
  if (!id || !game) return res.status(400).json({ error: "id and game required" });
  const meta = readMeta(id);
  meta.override = { game, generation: generation ?? "6" };
  writeMeta(id, meta);
  res.json({ ok: true, override: meta.override });
});

app.post("/api/saves/xy/region", (req, res) => {
  const { id, offset } = req.body || {};
  if (!id || offset === undefined) return res.status(400).json({ error: "id and offset required" });

  const offNum =
    typeof offset === "string" && /^0x/i.test(offset) ? Number(offset) : Number(offset);
  if (!Number.isInteger(offNum) || offNum < 0) return res.status(400).json({ error: "invalid offset" });

  const meta = readMeta(id);
  meta.xy = meta.xy || {};
  meta.xy.boxOffset = offNum;
  writeMeta(id, meta);

  // drop any stale boxes cache for this id
  try { fs.unlinkSync(boxesCachePath(id)); } catch {}

  res.json({ ok: true, xy: meta.xy });
});

/* -----------------------------------------------------------------------------
  Validate save
----------------------------------------------------------------------------- */

app.post("/api/saves/validate", (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "Provide JSON { id }" });

    const filePath = path.join(SAVES_DIR, id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

    const buf = fs.readFileSync(filePath);
    const filename = id.split("-").slice(2).join("-") || id;

    const detected = detectFormat(buf, filename);
    const override  = readMeta(id)?.override;
    const final     = override
      ? {
          ...detected,
          game: override.game,
          generation: override.generation,
          confidence: Math.max(detected.confidence ?? 0, 0.99),
          notes: `${detected.notes || ""} (override applied)`.trim(),
        }
      : detected;

    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    res.json({ filename, size: buf.length, sha256, detection: final });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Validation error" });
  }
});

/* -----------------------------------------------------------------------------
  Debug scan (XY): surface candidate offsets
----------------------------------------------------------------------------- */

app.get("/api/debug/xy/:id/scan", (req, res) => {
  const id = req.params.id;
  const filePath = path.join(SAVES_DIR, id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

  const buf = fs.readFileSync(filePath);
  if (!isLikelyXYSav(buf)) return res.status(400).json({ error: "Save does not look like XY" });

  const region = findBoxRegion(buf, undefined);
  res.json({
    fileSize: buf.length,
    candidates: region.debug || [],
    note: "Try the top candidate; if wrong, try the next.",
  });
});

/* -----------------------------------------------------------------------------
  Autofix (XY): fast auto-pick around a hint; persist best offset
----------------------------------------------------------------------------- */

app.post("/api/saves/xy/autofix", (req, res) => {
  try {
    const { id, hint } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    const filePath = path.join(SAVES_DIR, id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Save not found" });
    }

    const buf = fs.readFileSync(filePath);

    // parse hint (if provided)
    let hintNum = 0x22600; // default
    if (typeof hint === "string" && hint.length) {
      hintNum = /^0x/i.test(hint) ? Number(hint) : Number(hint);
    } else if (typeof hint === "number") {
      hintNum = hint;
    }

    // 1️⃣ Coarse scan near the hint
    const fast = XY.xyAutoPickOffsetFast(buf, hintNum);

    // 2️⃣ Fine-tune around the best offset
    const chosen = fast.best
      ? XY.refineAround(buf, fast.best.offset)
      : null;

    if (!chosen) {
      return res.json({ ok: false, reason: "no-candidate" });
    }

    // 3️⃣ Save the new offset in the save's metadata
    const meta = readMeta(id);
    meta.xyRegionOffset = chosen.offset;
    writeMeta(id, meta);

    // 4️⃣ Return results to the client
    res.json({
      ok: true,
      chosen,
      top: fast.top
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* -----------------------------------------------------------------------------
  Boxes view (with cache)
----------------------------------------------------------------------------- */

app.get("/api/boxes/:id", (req, res) => {
  try {
    const id = req.params.id;
    const filePath = path.join(SAVES_DIR, id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

    const buf = fs.readFileSync(filePath);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const filename = id.split("-").slice(2).join("-").toLowerCase();

    // Single-Pokémon convenience for raw .pk* / .pb* uploads
    if (/\.pk[1-9]$|\.pb[78]$/.test(filename)) {
      return res.json({
        game: "Single Pokémon file",
        generation: "unknown",
        boxes: [
          { id: "box-1", name: "Imported", mons: [{ slot: 1, label: filename, empty: false }] },
        ],
        notes: "Displayed as a single-slot import.",
        sha256,
      });
    }

    // Serve from cache if identical sha
    const cached = readBoxesCache(id);
    if (cached && cached.sha256 === sha256 && cached.payload) {
      return res.json(cached.payload);
    }

    const meta = readMeta(id) || {};
    let offset = meta?.xy?.boxOffset;

    // If no persisted offset, do a quick pick once
    if (offset == null && isLikelyXYSav(buf)) {
      const pick = xyAutoPickOffsetFast(buf, 0x22600);
      if (pick?.best?.offset != null) {
        offset = pick.best.offset;
        const m = readMeta(id) || {};
        m.xy = m.xy || {};
        m.xy.boxOffset = offset;
        writeMeta(id, m);
      }
    }

    // Decode boxes
    let view;
    if (isLikelyXYSav(buf)) {
      view = xyReadBoxes(buf, offset);
      view = { ...view, trainer: xyReadMeta(buf)?.trainer ?? null };
    } else {
      view = { game: "unknown", generation: "unknown", boxes: [], notes: "No parser for this game yet." };
    }

    // Attach sha and offsetUsed for UI clarity
    const payload = { ...view, sha256, offsetUsed: offset ?? view?.offset ?? null };

    // Save cache
    writeBoxesCache(id, { sha256, payload, savedAt: Date.now() });

    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Boxes error" });
  }
});

/* -----------------------------------------------------------------------------
  pk6 export (single route)
----------------------------------------------------------------------------- */

app.get("/api/boxes/:id/export", (req, res) => {
  const id = req.params.id;
  const box = Number(req.query.box);  // 1..31
  const slot = Number(req.query.slot); // 1..30
  if (!(box >= 1 && box <= 31 && slot >= 1 && slot <= 30)) {
    return res.status(400).json({ error: "box must be 1..31 and slot 1..30" });
  }

  const filePath = path.join(SAVES_DIR, id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

  const buf = fs.readFileSync(filePath);
  const meta = readMeta(id) || {};
  const region = findBoxRegion(buf, meta?.xy?.boxOffset);

  if (region.offset == null) {
    return res.status(400).json({ error: "XY region not found; set offset or run autofix." });
  }

  const slotIndex = (box - 1) * XY.SLOTS_PER_BOX + (slot - 1);
  const start = region.offset + slotIndex * XY.SLOT_SIZE;
  const end = start + XY.SLOT_SIZE;
  if (end > buf.length) return res.status(400).json({ error: "Computed slot out of range" });

  const blob = buf.subarray(start, end);

  // Empty?
  let nonzero = false;
  for (let i = 0; i < blob.length; i++) { if (blob[i] !== 0) { nonzero = true; break; } }
  if (!nonzero) return res.status(204).end();

  // Validate with same rules we use for display
  const d = XY.decodeSlot(blob);
  const valid =
    d &&
    d.checksumOK === true &&
    typeof d.species === "number" &&
    d.species >= 1 &&
    d.species <= 721 &&
    typeof d.pid === "number" &&
    d.pid !== 0;

  if (!valid) return res.status(204).end();

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="xy-box${box}-slot${slot}.pk6"`);
  res.send(Buffer.from(blob));
});


// Quick probe: decode a handful of slots at a given offset to sanity-check alignment
app.get("/api/debug/xy/:id/probe", (req, res) => {
  const id = req.params.id;
  const offStr = String(req.query.offset ?? "");
  const filePath = path.join(SAVES_DIR, id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

  const buf = fs.readFileSync(filePath);

  // parse hex (0x...) or decimal
  let base = 0;
  if (/^0x/i.test(offStr)) base = Number(offStr);
  else base = Number(offStr);
  if (!Number.isFinite(base) || base < 0) {
    return res.status(400).json({ error: "Provide ?offset=0xHEX or decimal" });
  }

  const results = [];
  const take = 20; // examine first ~20 slots (almost box 1)
  for (let i = 0; i < take; i++) {
    const start = base + i * XY.SLOT_SIZE;
    const end = start + XY.SLOT_SIZE;
    if (end > buf.length) break;
    const slice = buf.subarray(start, end);

    // zero test
    let nz = false;
    for (let j = 0; j < slice.length; j++) { if (slice[j] !== 0) { nz = true; break; } }
    if (!nz) {
      results.push({ slot: i + 1, empty: true });
      continue;
    }

    const d = XY.decodeSlot(slice);
    if (!d) {
      results.push({ slot: i + 1, empty: true, note: "invalid" });
      continue;
    }
    results.push({
      slot: i + 1,
      species: d.species,
      pid: d.pid,
      tid: d.tid,
      sid: d.sid,
      shiny: !!d.shiny,
      checksumOK: d.checksumOK === true,
    });
  }

  res.json({ offset: base, sampleCount: results.length, slots: results });
});

/* -----------------------------------------------------------------------------
  Start
----------------------------------------------------------------------------- */

const port = process.env.PORT || 8095;
app.listen(port, () => console.log(`openhome-api listening on :${port}`));
