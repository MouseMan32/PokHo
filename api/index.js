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
    // XY layout only (no real parsing yet)
    const boxes = Array.from({ length: 31 }, (_, i) => ({
      id: `box-${i + 1}`,
      name: `Box ${i + 1}`,
      mons: Array.from({ length: 30 }, (_, j) => ({ slot: j + 1, empty: true })),
    }));
    return res.json({
      game: "Pokémon X/Y (Citra)",
      generation: 6,
      boxes,
      notes: "Layout only; parsing not implemented yet.",
    });
  }

  return res.json({
    game: "unknown",
    generation: "unknown",
    boxes: [],
    notes: "No parser for this game yet. Set a manual override or upload a .pk* file.",
  });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`openhome-api listening on :${port}`));
