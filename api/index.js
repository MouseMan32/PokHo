// api/index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import cors from "cors";

import { detectFormat } from "./parsers/detect.mjs";
import {
  isLikelyXYSav,
  readMetadata as xyReadMeta,
  readBoxes as xyReadBoxes,
  findBoxRegion,
  XY,
  scoreXYRegion,        // <— optional if you use it
  xyAutoPickOffset      // <— required for /autofix route
} from "./parsers/gen6_xy.mjs";
import { readMeta, writeMeta } from "./store/meta.js";

/* ------------------------------- App setup ------------------------------- */
const app = express();

// CORS: allow your web UI on 8085 (or reflect any origin if preferred)
app.use(
  cors({
    origin: ["http://localhost:8085", "http://127.0.0.1:8085", "http://192.168.1.175:8085"],
    credentials: false,
  })
);

app.use(express.json());

/* ------------------------------- Paths/dirs ------------------------------ */
const SAVES_DIR = process.env.SAVES_DIR || "/data/saves";
const META_DIR = process.env.META_DIR || "/data/meta";
fs.mkdirSync(SAVES_DIR, { recursive: true });
fs.mkdirSync(META_DIR, { recursive: true });

/* ----------------------- Multer: write directly to /data ----------------- */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SAVES_DIR),
  filename: (_req, file, cb) => {
    const safeName = String(file.originalname || "upload").replace(/[^\w.\-]+/g, "_");
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeName}`;
    cb(null, id);
  },
});
const upload = multer({ storage });

/* ------------------------------ Health check ----------------------------- */
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ------------------------------ List all saves --------------------------- */
app.get("/api/saves", (_req, res) => {
  const files = fs.readdirSync(SAVES_DIR);
  res.json(files.map((f) => ({ id: f, name: f.split("-").slice(2).join("-") || f })));
});

/* -------------------------------- Upload save ---------------------------- */
/* Writes directly to /data/saves (no cross-device rename). */
app.post("/api/saves", upload.array("files"), (req, res) => {
  const uploaded = (req.files || []).map((f) => ({ id: f.filename, name: f.originalname }));
  return res.status(201).json({ uploaded });
});

/* ---------------- Manual game/generation override (persisted) ------------ */
app.post("/api/saves/override", (req, res) => {
  const { id, game, generation } = req.body || {};
  if (!id || !game) return res.status(400).json({ error: "id and game required" });
  const meta = readMeta(id) || {};
  meta.override = { game, generation: generation ?? "6" };
  writeMeta(id, meta);
  res.json({ ok: true, override: meta.override });
});

/* -------- Auto-fix XY offset: scan a window, pick best, persist ---------- */
app.post("/api/saves/xy/autofix", (req, res) => {
  const { id, hint } = req.body || {};
  if (!id) return res.status(400).json({ error: "id required" });

  const filePath = path.join(SAVES_DIR, id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

  const buf = fs.readFileSync(filePath);
  if (!isLikelyXYSav(buf)) return res.status(400).json({ error: "Save does not look like XY" });

  // Use provided hint or fall back to the one in meta, else 0x22600 as a last resort
  const meta = readMeta(id) || {};
  const startHint = Number(
    hint ?? meta?.xy?.boxOffset ?? 0x22600 // your closest candidate
  );

  // scan ±0x4000 around the hint in 0x10 steps; also test ±0x200 (size variant)
  const { best, top } = xyAutoPickOffset(buf, startHint);

  if (!best) return res.status(404).json({ error: "No plausible XY region found" });

  // Persist and return top candidates to the UI
  const m = readMeta(id) || {};
  m.xy = m.xy || {};
  m.xy.boxOffset = best.offset;
  writeMeta(id, m);

  res.json({
    ok: true,
    chosen: { offset: best.offset, score: best.score, reason: best.reason },
    top: top.slice(0, 8), // preview a few
  });
});


/* ------------------------------ Validate a save -------------------------- */
app.post("/api/saves/validate", (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "Provide JSON { id }" });

    const filePath = path.join(SAVES_DIR, id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

    const buf = fs.readFileSync(filePath);
    const filename = id.split("-").slice(2).join("-") || id;

    const detected = detectFormat(buf, filename);
    const override = readMeta(id)?.override;
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
    note: "Pick the top offset; if wrong, try the second.",
  });
});

/* ---------------- Manual set of XY region offset (persisted) ------------- */
app.post("/api/saves/xy/region", (req, res) => {
  const { id, offset } = req.body || {};
  if (!id || offset === undefined) return res.status(400).json({ error: "id and offset required" });

  const offNum =
    typeof offset === "string" && offset.trim().toLowerCase().startsWith("0x")
      ? Number(offset)
      : Number(offset);
  if (!Number.isInteger(offNum) || offNum < 0) return res.status(400).json({ error: "invalid offset" });

  const meta = readMeta(id) || {};
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
        boxes: [
          { id: "box-1", name: "Imported", mons: [{ slot: 1, label: filename, empty: false }] },
        ],
        notes: "Displayed as a single-slot import.",
      });
    }

    const meta = readMeta(id) || {};
    const overrideGame = meta?.override?.game || "";
    const xyOverrideOffset = meta?.xy?.boxOffset; // number or undefined

    const looksXY = overrideGame.startsWith("Pokémon X/Y") || isLikelyXYSav(buf);
    if (looksXY) {
      const view = xyReadBoxes(buf, xyOverrideOffset);
      const md = xyReadMeta(buf);

      // Auto-persist best candidate once (if none set yet)
      if (xyOverrideOffset == null && view?.debug?.length) {
        const best = view.debug[0];
        const m = readMeta(id) || {};
        m.xy = m.xy || {};
        m.xy.boxOffset = best.offset;
        writeMeta(id, m);
        view.notes =
          (view.notes ? view.notes + " " : "") + `Auto-saved offset 0x${best.offset.toString(16)}.`;
      }

      return res.json({ ...view, trainer: md.trainer });
    }

    return res.json({
      game: "unknown",
      generation: "unknown",
      boxes: [],
      notes: "No parser for this game yet.",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Boxes error" });
  }
});

/* ------------------- QOL: export one slot as .pk6 (XY) ------------------- */
app.get("/api/boxes/:id/export", (req, res) => {
  const id = req.params.id;
  const box = Number(req.query.box); // 1..31
  const slot = Number(req.query.slot); // 1..30

  if (!(box >= 1 && box <= 31 && slot >= 1 && slot <= 30)) {
    return res.status(400).json({ error: "box must be 1..31 and slot 1..30" });
  }

  const filePath = path.join(SAVES_DIR, id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });

  const buf = fs.readFileSync(filePath);
  const region = findBoxRegion(buf, readMeta(id)?.xy?.boxOffset);

  if (region.offset == null) {
    return res
      .status(400)
      .json({ error: "XY region not found; set offset via /api/saves/xy/region." });
  }

  const slotIndex = (box - 1) * XY.SLOTS_PER_BOX + (slot - 1);
  const start = region.offset + slotIndex * XY.SLOT_SIZE;
  const end = start + XY.SLOT_SIZE;
  if (end > buf.length) return res.status(400).json({ error: "Computed slot out of range" });

  const blob = buf.subarray(start, end);
  let allZero = true;
  for (let i = 0; i < blob.length; i++) {
    if (blob[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) return res.status(204).end();

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="xy-box${box}-slot${slot}.pk6"`
  );
  res.send(Buffer.from(blob));
});

/* --------------------------------- Start --------------------------------- */
const port = process.env.PORT || 8095;
app.listen(port, () => console.log(`openhome-api listening on :${port}`));
