
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(express.json());

const SAVES_DIR = process.env.SAVES_DIR || "/data/saves";
fs.mkdirSync(SAVES_DIR, { recursive: true });

const upload = multer({ dest: "/tmp/uploads" });

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

// TODO: add endpoints for boxes parsing, move/export, etc.

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`openhome-api listening on :${port}`));
