import React, { useEffect, useState } from "react";

type SaveItem = { id: string; name: string };
type Detection = {
  kind: string; game: string; generation: string | number; confidence: number; notes?: string;
};
type Validation = { filename: string; size: number; sha256: string; detection: Detection };
type BoxesResponse = { game: string; generation: string | number; notes?: string; trainer?: any; boxes: { id: string; name: string; mons: any[] }[] };

export default function App() {
  const [saves, setSaves] = useState<SaveItem[]>([]);
  const [validations, setValidations] = useState<Record<string, Validation>>({});
  const [boxes, setBoxes] = useState<Record<string, BoxesResponse>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshSaves() {
    try {
      const r = await fetch("/api/saves");
      if (!r.ok) throw new Error("Failed to load saves");
      setSaves(await r.json());
    } catch (e: any) {
      setError(e?.message || "Failed to reach API. Is openhome-api running?");
    }
  }
  useEffect(() => { refreshSaves(); }, []);

  async function uploadChanged(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return;
    setBusy(true); setError(null);
    const form = new FormData();
    Array.from(e.target.files).forEach(f => form.append("files", f));
    try {
      const r = await fetch("/api/saves", { method: "POST", body: form });
      if (!r.ok) throw new Error("Upload failed");
      const { uploaded } = await r.json();
      await refreshSaves();
      // auto-validate new uploads
      for (const f of uploaded) await validateById(f.id);
    } catch (e:any) {
      setError(e?.message || "Upload error");
    } finally {
      setBusy(false);
      e.currentTarget.value = "";
    }
  }

  async function validateById(id: string) {
    const r = await fetch("/api/saves/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    if (!r.ok) throw new Error("Validation failed");
    const v: Validation = await r.json();
    setValidations(prev => ({ ...prev, [id]: v }));
  }

  async function setOverride(id: string, game: string, generation = "6") {
    const r = await fetch("/api/saves/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, game, generation })
    });
    if (!r.ok) throw new Error("Failed to set override");
    await validateById(id);
  }

async function fetchBoxes(id: string) {
  const r = await fetch(`/api/boxes/${id}`);
  if (!r.ok) throw new Error("Boxes fetch failed");
  const data = await r.json();              // ✅ await here
  setBoxes(prev => ({ ...prev, [id]: data })); 
}


  async function scanXY(id: string) {
    const r = await fetch(`/api/debug/xy/${encodeURIComponent(id)}/scan`);
    const j = await r.json();
    alert(
      j.candidates?.length
        ? "Top candidates:\n" + j.candidates.map((c:any)=>`offset=0x${c.offset.toString(16)}  score=${(c.score*100).toFixed(1)}%`).join("\n")
        : (j.error || "No candidates found")
    );
  }

  async function setXYOffset(id: string) {
    const off = prompt("Enter XY region offset (hex like 0x1A000 or decimal):");
    if (!off) return;
    const r = await fetch(`/api/saves/xy/region`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, offset: off })
    });
    if (!r.ok) { alert("Failed to set offset"); return; }
    await fetchBoxes(id);
    alert("Offset saved. Reopen boxes to apply.");
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1 style={{ marginBottom: 8 }}>OpenHome Web</h1>
      <p style={{ marginTop: 0, color: "#555" }}>
        Upload a save, then click <b>Validate</b> and <b>View Boxes</b>. For Pokémon X/Y (Citra), use <b>Scan XY Region</b> and <b>Set XY Offset</b> if needed.
      </p>

      <div style={{ margin: "12px 0" }}>
        <label style={{ display: "inline-block", padding: "8px 12px", border: "1px solid #ddd", borderRadius: 8, cursor: "pointer" }}>
          {busy ? "Uploading…" : "Upload save(s)"}
          <input type="file" multiple onChange={uploadChanged} style={{ display: "none" }} disabled={busy} />
        </label>
        <button onClick={refreshSaves} style={{ marginLeft: 8 }}>Refresh</button>
        {error && <span style={{ marginLeft: 12, color: "crimson" }}>{error}</span>}
      </div>

      {!saves.length ? (
        <div style={{ color: "#777" }}>No saves yet. Upload a <code>main</code> file (Citra/JKSV) or a <code>.pk*</code> file.</div>
      ) : (
        <div style={{ maxWidth: 980 }}>
          {saves.map((s) => {
            const v = validations[s.id];
            const b = boxes[s.id];
            return (
              <div key={s.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    <div style={{ fontSize: 12, color: "#666" }}>{s.id}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => validateById(s.id)}>Validate</button>
                    <button onClick={() => fetchBoxes(s.id)}>View Boxes</button>
                    <button onClick={() => scanXY(s.id)}>Scan XY Region</button>
                    <button onClick={() => setXYOffset(s.id)}>Set XY Offset</button>
                  </div>
                </div>

                {v && (
                  <div style={{ marginTop: 8, fontSize: 14, color: "#333" }}>
                    <div>Detected: {v.detection.kind} → {v.detection.game} (gen {String(v.detection.generation)}), confidence {Math.round((v.detection.confidence ?? 0) * 100)}%</div>
                    {v.detection.notes && <div style={{ fontStyle: "italic" }}>{v.detection.notes}</div>}
                    {v.detection.game === "unknown" && (
                      <div style={{ marginTop: 6 }}>
                        <span>Set Game: </span>
                        <button onClick={() => setOverride(s.id, "Pokémon X/Y (Citra)", "6")}>Pokémon X/Y (Citra)</button>
                        {/* add more quick-picks later */}
                      </div>
                    )}
                  </div>
                )}

                {b && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontWeight: 600 }}>
                      {b.game} (Gen {String(b.generation)})
                      {b.trainer?.ot && <span style={{ marginLeft: 8, fontWeight: 400, color: "#666" }}>OT: {b.trainer.ot}</span>}
                    </div>
                    {b.notes && <div style={{ fontStyle: "italic" }}>{b.notes}</div>}
                    {b.boxes?.length ? (
                      <div style={{ marginTop: 8 }}>
                        {b.boxes.map((box) => (
                          <div key={box.id} style={{ marginBottom: 8 }}>
                            <div style={{ fontWeight: 500, marginBottom: 4 }}>{box.name}</div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 32px)", gap: 4 }}>
                              {box.mons.map((mon: any, i: number) => (
                                <div
                                  key={i}
                                  title={mon.label || (mon.empty ? "Empty" : "Occupied")}
                                  style={{
                                    width: 32,
                                    height: 32,
                                    border: "1px solid #bbb",
                                    background: mon.empty ? "#f1f1f1" : "#b6f5b6",
                                  }}

