// web/src/App.tsx
import React, { useState, useEffect } from "react";

type SaveItem = { id: string; name: string };
type Detection = {
  kind: string;
  game: string;
  generation: string | number;
  confidence: number;
  notes?: string;
};

export default function App() {
  const [saves, setSaves] = useState<SaveItem[]>([]);
  const [validations, setValidations] = useState<Record<string, { detection: Detection; filename: string; size: number; sha256: string }>>({});
  const [boxes, setBoxes] = useState<Record<string, any>>({});
  const [uploading, setUploading] = useState(false);

  async function fetchSaves() {
    const r = await fetch("/api/saves");
    const data = await r.json();
    setSaves(data);
  }

  useEffect(() => {
    fetchSaves();
  }, []);

  async function uploadFiles(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;
    setUploading(true);
    const form = new FormData();
    for (const file of Array.from(e.target.files)) {
      form.append("files", file);
    }
    const r = await fetch("/api/saves", { method: "POST", body: form });
    if (r.ok) {
      await fetchSaves();
    }
    setUploading(false);
  }

  async function validateById(id: string) {
    const r = await fetch("/api/saves/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!r.ok) throw new Error("Validation failed");
    const data = await r.json();
    setValidations((prev) => ({ ...prev, [id]: data }));
  }

  async function setOverride(id: string, game: string, generation = "6") {
    const r = await fetch("/api/saves/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, game, generation }),
    });
    if (!r.ok) throw new Error("Failed to set override");
  }

  async function fetchBoxes(id: string) {
    const r = await fetch(`/api/boxes/${id}`);
    if (!r.ok) throw new Error("Boxes fetch failed");
    const data = await r.json();
    setBoxes((prev) => ({ ...prev, [id]: data }));
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h1>OpenHome Web</h1>
      <div style={{ marginBottom: 20 }}>
        <input type="file" multiple onChange={uploadFiles} />
        {uploading && <span> Uploading...</span>}
      </div>
      <div>
        {saves.map((s) => {
          const v = validations[s.id];
          const b = boxes[s.id];
          return (
            <div key={s.id} style={{ border: "1px solid #ccc", padding: 10, marginBottom: 10 }}>
              <strong>{s.name}</strong>
              <div>
                <button onClick={() => validateById(s.id)}>Validate</button>{" "}
                <button onClick={() => fetchBoxes(s.id)}>View Boxes</button>
              </div>
              {v && (
                <div style={{ marginTop: 6 }}>
                  <div>
                    Detected: {v.detection.kind} → {v.detection.game} (gen {String(v.detection.generation)}), confidence{" "}
                    {Math.round((v.detection.confidence ?? 0) * 100)}%
                  </div>
                  {v.detection.notes && <div style={{ fontStyle: "italic" }}>{v.detection.notes}</div>}
                  {v.detection.game === "unknown" && (
                    <div style={{ marginTop: 6 }}>
                      <label>Set Game:</label>{" "}
                      <button
                        onClick={async () => {
                          await setOverride(s.id, "Pokémon X/Y (Citra)", "6");
                          await validateById(s.id);
                          alert("Override saved");
                        }}
                      >
                        Pokémon X/Y (Citra)
                      </button>
                      {/* Add more quick-pick overrides here as needed */}
                    </div>
                  )}
                </div>
              )}
              {b && (
                <div style={{ marginTop: 10 }}>
                  <div>
                    <strong>Game:</strong> {b.game} (Gen {String(b.generation)})
                  </div>
                  {b.notes && <div style={{ fontStyle: "italic" }}>{b.notes}</div>}
                  {b.boxes && b.boxes.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      {b.boxes.map((box: any) => (
                        <div key={box.id} style={{ marginBottom: 8 }}>
                          <strong>{box.name}</strong>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 40px)", gap: "2px", marginTop: 4 }}>
                            {box.mons.map((mon: any, idx: number) => (
                              <div
                                key={idx}
                                style={{
                                  width: 40,
                                  height: 40,
                                  border: "1px solid #999",
                                  background: mon.empty ? "#eee" : "#9f9",
                                }}
                                title={mon.label || ""}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
