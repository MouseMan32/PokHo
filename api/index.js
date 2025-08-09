import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { detectFormat } from "./parsers/detect.js"; // <-- NEW

const app = express();
app.use(express.json());

const SAVES_DIR = process.env.SAVES_DIR || "/data/saves";
fs.mkdirSync(SAVES_DIR, { recursive: true });

const upload = multer({ dest: "/tmp/uploads" });

// --- existing endpoints (health, list, upload) ---
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/saves", (_req, res) => {
  const files = fs.readdirSync(SAVES_DIR);
  res.json(files.map((f) => ({ id: f, name: f })));
});

app.post("/api/saves", upload.array("files"), (req, res) => {
  const uploaded = [];
  for (const file of req.files) {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${file.originalname}`;
    fs.renameSync(file.path, path.join(SAVES_DIR, id));
    uploaded.push({ id, name: file.originalname });
  }
  res.status(201).json({ uploaded });
});

// --- NEW: validate by file id OR upload-on-validate ---
app.post("/api/saves/validate", upload.single("file"), (req, res) => {
  try {
    let filePath, filename;

    // Two modes:
    //  A) validate an uploaded file immediately (multipart field "file")
    //  B) validate a previously uploaded file by id (json {id})
    if (req.file) {
      filePath = req.file.path;
      filename = req.file.originalname;
    } else if (req.body && req.body.id) {
      const id = String(req.body.id);
      filePath = path.join(SAVES_DIR, id);
      filename = id.split("-").slice(2).join("-") || id; // best effort
    } else {
      return res.status(400).json({ error: "Provide multipart 'file' or JSON {id}" });
    }

    const buf = fs.readFileSync(filePath);
    const meta = detectFormat(buf, filename);

    // Minimal metadata for UI
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const size = buf.length;

    return res.json({
      filename,
      size,
      sha256,
      detection: meta,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Validation error" });
  } finally {
    // If it was a temp upload (not already stored), remove it
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
  }
});

// --- NEW: stub for returning boxes (later real parsing) ---
app.get("/api/boxes/:id", (req, res) => {
  // For now, we don't parse saves yet. If the uploaded file was a single Pokémon (.pk*),
  // we can surface it as a 1-slot "box" for demo. Otherwise return a stub structure.
  const id = req.params.id;
  const filename = id.split("-").slice(2).join("-").toLowerCase();
  const isPK = /\.pk[1-9]$|\.pb[78]$/.test(filename);
  if (isPK) {
    return res.json({
      game: "unknown",
      generation: "unknown",
      boxes: [
        {
          id: "box-1",
          name: "Imported",
          mons: [{ id: "1", label: filename }]
        }
      ]
    });
  }
  return res.json({
    game: "unknown",
    generation: "unknown",
    boxes: [],
    notes: "Save parsing not implemented yet. Use 'Set Game' in UI for manual override."
  });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`openhome-api listening on :${port}`));
