// api/index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import { detectFormat } from "./parsers/detect.js";
import {
  isLikelyXYSav,
  readMetadata as xyReadMeta,
  readBoxes as xyReadBoxes,
  findBoxRegion,
  XY
} from "./parsers/gen6_xy.js";
import { readMeta, writeMeta } from "./store/meta.js";

import cors from "cors";

// allow local dev ports only
app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ],
  credentials: false
}));

const app = express();
app.use(express.json());

// Where uploaded saves live (mounted as a volume in docker-compose)
const SAVES_DIR = process.env.SAVES_DIR || "/data/saves";
fs.mkdirSync(SAVES_DIR, { recursive: true });

// Temp dir for multipart uploads
const upload = multer({ dest: "/tmp/uploads" });

/* ----------------------------- Health check ------------------------------ */
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ----------------------------- List all saves ---------------------------- */
app.get("/api/saves", (_req, res) => {
  const files = fs.readdirSync(SAVES_DIR);
  res.json(files.map((f) => ({ id: f, name: f })));
});

/* ------------------------------- Upload save ----------------------------- */
app.post("/api/saves", upload.array("files"), (req, res) => {
  const uploaded = [];
  for (const file of req.files) {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${file.originalname}`;
    fs.renameSync(file.path, path.join(SAVES_DIR, id));
    uploaded.push({ id, name: file.originalname });
  }
  res.status(201).json({ uploaded });
});

/* ------------------------- Manual game/generation override --------------- */
app.post("/api/saves/override", (req, res) => {
  const { id, game, generation } = req.body || {};
  if (!id || !game) return res.status(400).json({ error: "id and game required" });
  const meta = readMeta(id);
  meta.override = { game, generation: generation ?? "6" };
  writeMeta(id, meta);
  res.json({ ok: true, override: meta.override });
});

/* ----------------------------- Validate a save --------------------------- */
/* Modes:
   A) multipart with field "file" (validate immediately, not persisted)
   B) JSON { id } to validate an already-uploaded file from SAVES_DIR
*/
app.post("/api/saves/validate", upload.single("file"), (req, res) => {
  try {
    let filePath, filename, uploadedId;
    if (req.file) {
      filePath = req.file.path;
      filename = req.file.originalname;
    } else if (req.body?.id) {
      uploadedId = String(req.body.id);
      filePath = path.join(SAVES_DIR, uploadedId);
      filename = uploadedId.split("-").slice(2).join("-") || uploadedId;
    } else {
      return res.status(400).json({ error: "Provide multipart 'file' or JSON {id}" });
    }

    const buf = fs.readFileSync(filePath);
    const detected = detectFormat(buf, filename);

    // Merge any user override
    const override = uploadedId ? readMeta(uploadedId).override : undefined;
    const finalDetection = override
      ? {
          ...detected,
          game: override.game,
          generation: override.generation,
          confidence: Math.max(detected.confidence ?? 0, 0.99),
          notes: `${detected.notes || ""} (override applied)`.trim(),
        }
      : detected;

    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    res.json({ filename, size: buf.length, sha256, detection: finalDetection });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Validation error" });
  } finally {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
  }
});

/* ------------------ Debug: scan for likely XY region offsets ------------- */
app.get("/api/debug/xy/:id/scan", (req, res) => {
  const id = req.params.id;
  const filePath = path.join(SAVES_DIR, id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });
  const buf = fs.readFileSync(filePath);
  if (!isLikelyXYSav(buf)) {
    return res.status(400).json({ error: "Save does not look like XY (Citra) by size" });
  }
  const view = xyReadBoxes(buf, undefined); // uses internal scan and returns debug candidates
  res.json({
    fileSize: buf.length,
    candidates: view.debug || [],
    note: "Pick the top offset; if it looks wrong, try the second."
  });
});

/* ---------------- Manual set of XY region offset (persisted) ------------- */
app.post("/api/saves/xy/region", (req, res) => {
  const { id, offset } = req.body || {};
  if (!id || offset === undefined) return res.status(400).json({ error: "id and offset required" });

  let offNum = typeof offset === "string" && offset.trim().startsWith("0x")
    ? Number(offset)
    : Number(offset);

  if (!Number.isInteger(offNum) || offNum < 0) return res.status(400).json({ error: "invalid offset" });

  const meta = readMeta(id);
  meta.xy = meta.xy || {};
  meta.xy.boxOffset = offNum;
  writeMeta(id, meta);
  res.json({ ok: true, xy: meta.xy });
});

/* ----------------------- MAIN: get boxes/slots for a save ---------------- */
app.get("/api/boxes/:id", (req, res) => {
  try {
    const id = req.params.id;
    const filePath = path.join(SAVES_DIR, id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

    const buf = fs.readFileSync(filePath);
    const filename = id.split("-").slice(2).join("-").toLowerCase();

    // Single-Pokémon convenience: .pk* / .pb*
    if (/\.pk[1-9]$|\.pb[78]$/.test(filename)) {
      return res.json({
        game: "Single Pokémon file",
        generation: "unknown",
        boxes: [{ id: "box-1", name: "Imported", mons: [{ slot: 1, label: filename, empty: false }] }],
        notes: "Displayed as a single-slot import."
      });
    }

    const meta = readMeta(id);
    const overrideGame = meta?.override?.game || "";
    const xyOverrideOffset = meta?.xy?.boxOffset; // number or undefined

    const looksXY = overrideGame.startsWith("Pokémon X/Y") || isLikelyXYSav(buf);
    if (looksXY) {
      // Build view (includes occupancy + debug candidates if scanning)
      const view = xyReadBoxes(buf, xyOverrideOffset);
      const md   = xyReadMeta(buf);

      // QOL: auto-persist best candidate once, so future loads are instant
      if (xyOverrideOffset == null && view?.debug?.length) {
        const best = view.debug[0]; // { offset, score, ... }
        const m = readMeta(id);
        m.xy = m.xy || {};
        m.xy.boxOffset = best.offset;
        writeMeta(id, m);
        view.notes = (view.notes ? view.notes + " " : "") + `Auto-saved offset 0x${best.offset.toString(16)}.`;
      }

      return res.json({ ...view, trainer: md.trainer });
    }

    // Fallback: unknown format
    return res.json({
      game: "unknown",
      generation: "unknown",
      boxes: [],
      notes: "No parser for this game yet. Set a manual override or upload a .pk* file."
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Boxes error" });
  }
});

/* ------------------- QOL: export one slot as .pk6 (XY) ------------------- */
/* Example: GET /api/boxes/<id>/export?box=1&slot=12
   - 204 No Content if the slot is empty
   - application/octet-stream with 232 bytes if present
*/
app.get("/api/boxes/:id/export", (req, res) => {
  const id = req.params.id;
  const box = Number(req.query.box);   // 1..31
  const slot = Number(req.query.slot); // 1..30

  if (!(box >= 1 && box <= 31 && slot >= 1 && slot <= 30)) {
    return res.status(400).json({ error: "box must be 1..31 and slot 1..30" });
  }

  const filePath = path.join(SAVES_DIR, id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

  const buf = fs.readFileSync(filePath);

  // Use saved offset if available, otherwise find/scan
  const meta = readMeta(id);
  const region = findBoxRegion(buf, meta?.xy?.boxOffset);

  if (region.offset == null) {
    return res.status(400).json({ error: "XY region not found; set offset via /api/saves/xy/region." });
  }

  const slotIndex = (box - 1) * XY.SLOTS_PER_BOX + (slot - 1);
  const start = region.offset + slotIndex * XY.SLOT_SIZE;
  const end = start + XY.SLOT_SIZE;
  if (end > buf.length) return res.status(400).json({ error: "Computed slot out of range" });

  const blob = buf.subarray(start, end);

  // Return 204 if empty
  let allZero = true;
  for (let i = 0; i < blob.length; i++) { if (blob[i] !== 0) { allZero = false; break; } }
  if (allZero) return res.status(204).end();

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="xy-box${box}-slot${slot}.pk6"`);
  res.send(Buffer.from(blob));
});

/* ------------------------------- Start server ---------------------------- */
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`openhome-api listening on :${port}`));
