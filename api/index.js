// api/index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import { detectFormat } from "./parsers/detect.js";
import { readMeta, writeMeta } from "./store/meta.js";

const app = express();
app.use(express.json());

const SAVES_DIR = process.env.SAVES_DIR || "/data/saves";
fs.mkdirSync(SAVES_DIR, { recursive: true });

// temp upload dir for multipart form-data
const upload = multer({ dest: "/tmp/uploads" });

/**
 * Health check
 */
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/**
 * List uploaded saves (filenames stored in SAVES_DIR)
 */
app.get("/api/saves", (_req, res) => {
  const files = fs.readdirSync(SAVES_DIR);
  res.json(files.map((f) => ({ id: f, name: f })));
});

/**
 * Upload saves (one or many). Files are persisted into SAVES_DIR with a unique id.
 */
app.post("/api/saves", upload.array("files"), (req, res) => {
  const uploaded = [];
  for (const file of req.files) {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${file.originalname}`;
    fs.renameSync(file.path, path.join(SAVES_DIR, id));
    uploaded.push({ id, name: file.originalname });
  }
  res.status(201).json({ uploaded });
});

/**
 * Manually override detected game/generation for a given uploaded save.
 * Body: { id: string, game: string, generation?: string|number }
 */
app.post("/api/saves/override", (req, res) => {
  const { id, game, generation } = req.body || {};
  if (!id || !game) return res.status(400).json({ error: "id and game required" });
  const meta = readMeta(id);
  meta.override = { game, generation: generation ?? "6" }; // default gen 6 for X/Y
  writeMeta(id, meta);
  res.json({ ok: true, override: meta.override });
});

/**
 * Validate a save to identify format & basic metadata.
 * Modes:
 *  A) multipart with field "file" (validate immediately, not persisted)
 *  B) JSON { id } to validate a previously uploaded file from SAVES_DIR
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
    res.json({
      filename,
      size: buf.length,
      sha256,
      detection: finalDetection,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Validation error" });
  } finally {
    // Clean up temp file if this was a direct-upload validation
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
  }
});

/**
 * Boxes stub:
 * - If override says "Pokémon X/Y (Citra)", return XY-style grid (31 boxes x 30 slots), empty for now.
 * - If the uploaded file is a single Pokémon (.pk*/.pb*), surface a simple 1-box view.
 * - Otherwise, return empty until a specific parser is implemented.
 */
app.get("/api/boxes/:id", (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id);
  const game = meta?.override?.game || "unknown";

  // Single-Pokémon convenience: detect by filename extension
  const filename = id.split("-").slice(2).join("-").toLowerCase();
  const isPK = /\.pk[1-9]$|\.pb[78]$/.test(filename);

  if (isPK) {
    return res.json({
      game: "Single Pokémon file",
      generation: "unknown",
      boxes: [
        {
          id: "box-1",
          name: "Imported",
          mons: [{ slot: 1, label: filename, empty: false }],
        },
      ],
      notes: "Displayed as a single-slot import.",
    });
  }

  if (game.startsWith("Pokémon X/Y")) {
    // XY has 31 boxes of 30 slots each
    const boxes = Array.from({ length: 31 }, (_, i) => ({
      id: `box-${i+1}`,
      name: `Box ${i+1}`,
      mons: Array.from({ length: 30 }, (_, j) => ({ slot: j+1, empty: true }))
    }));
    return res.json({ game: "Pokémon X/Y (Citra)", generation: 6, boxes, notes: "Layout only; parsing not implemented yet." });
  }

  return res.json({ game: "unknown", generation: "unknown", boxes: [], notes: "No parser for this game yet." });
});

// Export one XY slot as a .pk6 file (232 bytes). Empty slots return 204 No Content.
app.get("/api/boxes/:id/export", async (req, res) => {
  const id = req.params.id;
  const box = Number(req.query.box);   // 1..31
  const slot = Number(req.query.slot); // 1..30

  if (!(box >= 1 && box <= 31 && slot >= 1 && slot <= 30)) {
    return res.status(400).json({ error: "box must be 1..31 and slot 1..30" });
  }

  const filePath = path.join(SAVES_DIR, id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Save not found" });
  const buf = fs.readFileSync(filePath);

  const { XY, findBoxRegion } = await import("./parsers/gen6_xy.js");
  const { readMeta } = await import("./store/meta.js");
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
  // Empty check
  let allZero = true;
  for (let i = 0; i < blob.length; i++) { if (blob[i] !== 0) { allZero = false; break; } }
  if (allZero) return res.status(204).end();

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="xy-box${box}-slot${slot}.pk6"`);
  res.send(Buffer.from(blob));
});


const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`openhome-api listening on :${port}`));
