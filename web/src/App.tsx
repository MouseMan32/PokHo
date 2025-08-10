// web/src/App.tsx
import React, { useEffect, useState } from "react";
import "./home.css";
import { fetchSpeciesName, getCachedName } from "./speciesNames";

/** Sprites **/
function spriteUrl(species?: number | null, shiny?: boolean) {
  if (!species) return null;
  // PokeAPI sprite CDN (simple & reliable)
  return shiny
    ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/${species}.png`
    : `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${species}.png`;
}

/** Types */
type SaveItem = { id: string; name: string };
type Detection = { kind: string; game: string; generation: string | number; confidence: number; notes?: string };
type Validation = { filename: string; size: number; sha256: string; detection: Detection };
type Mon = {
  slot: number;
  empty?: boolean;
  label?: string;
  preview?: string;
  hash?: string;
  species?: number | null;
  nature?: number | null;
  shiny?: boolean;
  pid?: number | null;
  tid?: number | null;
  sid?: number | null;
  checksumOK?: boolean | null;
};
type Box = { id: string; name: string; mons: Mon[] };
type BoxesResponse = { game: string; generation: string | number; notes?: string; trainer?: any; boxes: Box[] };

/** API base + helper */
const API_BASE = (import.meta as any).env?.VITE_API_URL ?? "http://192.168.1.175:8095";
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, init);
  if (!r.ok) throw new Error(await r.text().catch(() => r.statusText));
  return r.json();
}

export default function App() {
  /** app state */
  const [saves, setSaves] = useState<SaveItem[]>([]);
  const [validations, setValidations] = useState<Record<string, Validation>>({});
  const [boxesBySave, setBoxesBySave] = useState<Record<string, BoxesResponse>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /** selection */
  const [saveId, setSaveId] = useState<string | null>(null);
  const [boxIndex, setBoxIndex] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState<{ box: number; slot: number } | null>(null);

  /** derived */
  const selectedBoxes = saveId ? boxesBySave[saveId]?.boxes || [] : [];
  const currentBox = selectedBoxes[boxIndex];

  const [nameCache, setNameCache] = useState<Record<number, string>>({});

  useEffect(() => {
    // Prefetch names for all species visible in the current box
    const species = new Set<number>();
    currentBox?.mons.forEach((m) => {
      if (!m.empty && m.species) species.add(m.species);
    });

    if (species.size === 0) return;

    (async () => {
      const updates: Record<number, string> = {};
      // seed from localStorage if present
      species.forEach((id) => {
        const cached = getCachedName(id);
        if (cached) updates[id] = cached;
      });
      // fetch any missing
      await Promise.all(
        Array.from(species)
          .filter((id) => !updates[id])
          .map(async (id) => {
            const name = await fetchSpeciesName(id);
            updates[id] = name;
          })
      );
      if (Object.keys(updates).length) {
        setNameCache((prev) => ({ ...prev, ...updates }));
      }
    })();
  }, [currentBox]);

  /** init */
  useEffect(() => {
    refreshSaves();
  }, []);

  async function refreshSaves() {
    try {
      setErr(null);
      const list = await api<SaveItem[]>("/api/saves");
      setSaves(list);
      if (!saveId && list.length) setSaveId(list[0].id);
    } catch (e: any) {
      setErr(e?.message || "Failed to reach API");
    }
  }

  /** actions */
  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return;
    setBusy(true);
    setErr(null);
    const form = new FormData();
    Array.from(e.target.files).forEach((f) => form.append("files", f));
    try {
      const { uploaded } = await api<{ uploaded: SaveItem[] }>("/api/saves", {
        method: "POST",
        body: form,
      });
      await refreshSaves();
      if (uploaded?.[0]?.id) {
        setSaveId(uploaded[0].id);
        await validateSave(uploaded[0].id);
        await loadBoxes(uploaded[0].id); // auto-open boxes after upload
      }
      // still validate any extras
      for (const f of uploaded.slice(1)) await validateSave(f.id);
    } catch (e: any) {
      setErr(e?.message || "Upload error");
    } finally {
      setBusy(false);
      e.currentTarget.value = "";
    }
  }

  async function validateSave(id: string) {
    const v = await api<Validation>("/api/saves/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setValidations((prev) => ({ ...prev, [id]: v }));
  }

  async function setOverride(id: string, game: string, generation = "6") {
    await api("/api/saves/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, game, generation }),
    });
    await validateSave(id);
  }

  async function loadBoxes(id: string) {
    const data = await api<BoxesResponse>(`/api/boxes/${id}`);
    setBoxesBySave((prev) => ({ ...prev, [id]: data }));
    setBoxIndex(0);
    setSelectedSlot(null);
  }

  async function scanXY(id: string) {
    try {
      const j = await api<any>(`/api/debug/xy/${encodeURIComponent(id)}/scan`);
      const lines = (j.candidates || []).map(
        (c: any) => `offset=0x${c.offset.toString(16)}  score=${(c.score * 100).toFixed(1)}%`
      );
      alert(lines.length ? `Top candidates:\n${lines.join("\n")}` : "No candidates found");
    } catch (e: any) {
      alert(e?.message || "Scan failed");
    }
  }

  async function setXYOffset(id: string) {
    const off = prompt("Enter XY region offset (hex like 0x1A000 or decimal):");
    if (!off) return;
    await api(`/api/saves/xy/region`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, offset: off }),
    });
    await loadBoxes(id);
    alert("Offset saved.");
  }

  /** render */
  return (
    <div className="app-shell">
      {/* Topbar */}
      <div className="topbar">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="#34d399" strokeWidth="2" />
            <circle cx="12" cy="12" r="3" fill="#34d399" />
          </svg>
        </div>
        <div className="tabs">
          <div className="tab active">Home</div>
          <div className="tab">Boxes</div>
          <div className="tab">Search</div>
          <div className="tab">Settings</div>
        </div>
      </div>

      {/* Sidebar */}
      <div className="sidebar">
        <div className="section-title">Your Saves</div>
        <div className="dropzone">
          <label style={{ cursor: "pointer" }}>
            <input type="file" multiple onChange={onUpload} style={{ display: "none" }} disabled={busy} />
            {busy ? "Uploading…" : "Click to upload saves"}
          </label>
        </div>

        {!saves.length && (
          <div className="small" style={{ marginTop: 10 }}>
            No saves yet. Upload a <code>main</code> (Citra/JKSV) or <code>.pk*</code>.
          </div>
        )}

        {saves.map((s) => {
          const v = validations[s.id];
          const selected = s.id === saveId;
          return (
            <div key={s.id} className="save-card" style={{ outline: selected ? "2px solid rgba(96,165,250,.35)" : "none" }}>
              <div className="save-name">{s.name}</div>
              <div className="small">{s.id}</div>
              <div className="save-actions">
                <button className="btn" onClick={() => { setSaveId(s.id); validateSave(s.id); }}>
                  Validate
                </button>
                <button className="btn primary" onClick={() => { setSaveId(s.id); loadBoxes(s.id); }}>
                  Open Boxes
                </button>
                <button className="btn" onClick={() => scanXY(s.id)}>Scan XY</button>
                <button className="btn warning" onClick={() => setXYOffset(s.id)}>Set XY Offset</button>
              </div>
              {v && (
                <div className="small" style={{ marginTop: 8 }}>
                  Detected: <b>{v.detection.game}</b> (Gen {String(v.detection.generation)}) — conf{" "}
                  {Math.round((v.detection.confidence ?? 0) * 100)}%
                  {v.detection.notes && <div>{v.detection.notes}</div>}
                </div>
              )}
            </div>
          );
        })}

        {err && <div className="small" style={{ color: "#fca5a5", marginTop: 8 }}>{err}</div>}
      </div>

      {/* Main (Boxes) */}
      <div className="main">
        {saveId ? (
          <>
            <div className="box-header">
              <div className="box-switcher">
                <button className="navbtn" onClick={() => setBoxIndex((i) => Math.max(0, i - 1))}>‹</button>
                <div className="pill">
                  Save: <strong style={{ marginLeft: 6 }}>{saves.find((s) => s.id === saveId)?.name || "—"}</strong>
                </div>
                <div className="pill">
                  Box: <strong style={{ marginLeft: 6 }}>{(boxIndex + 1).toString().padStart(2, "0")}</strong>
                </div>
                {currentBox && (
                  <div className="pill">
                    Occupied:{" "}
                    <strong style={{ marginLeft: 6 }}>
                      {currentBox.mons.filter((m) => !m.empty).length} / {currentBox.mons.length}
                    </strong>
                  </div>
                )}
                <button
                  className="navbtn"
                  onClick={() => setBoxIndex((i) => Math.min(Math.max(0, selectedBoxes.length - 1), i + 1))}
                >
                  ›
                </button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={() => saveId && loadBoxes(saveId)}>Reload Boxes</button>
              </div>
            </div>

            {!selectedBoxes.length ? (
              <div className="small">Open a save and click <b>Open Boxes</b> to load the grid.</div>
            ) : !currentBox ? (
              <div className="small">No such box index. Use the arrows to navigate.</div>
            ) : (
              <div className="grid">
                {currentBox.mons.map((mon, idx) => {
                  const occupied = !mon.empty;
                  return (
                    <div
                      key={idx}
                      className={`slot ${occupied ? "occupied" : "empty"}`}
                      onClick={() => setSelectedSlot({ box: boxIndex + 1, slot: mon.slot })}
                      onDoubleClick={() => {
                        if (saveId && occupied) {
                          const url = `/api/boxes/${encodeURIComponent(saveId)}/export?box=${boxIndex + 1}&slot=${mon.slot}`;
                          window.open(url, "_blank");
                        }
                      }}
                      title={occupied ? "Double-click to download .pk6" : "Empty"}
                      style={{ position: "relative" }}
                    >
                      {occupied && mon.species && (
                        <img
                          src={spriteUrl(mon.species, mon.shiny)!}
                          alt={`#${mon.species}`}
                          className="slot-sprite"
                          draggable={false}
                        />
                      )}
                    </div>
                  );
              })}
        </div>

            )}
          </>
        ) : (
          <div className="small">Select a save on the left to begin.</div>
        )}
      </div>

      {/* Details */}
      <div className="details">
        <div className="section-title">Details</div>
        {!saveId ? (
          <div className="detail-card small">No save selected.</div>
        ) : (
          <>
            <div className="detail-card">
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Save</div>
              <div className="kv">
                <label>ID</label><div>{saveId}</div>
                <label>Name</label><div>{saves.find((s) => s.id === saveId)?.name}</div>
                <label>Game</label><div>{boxesBySave[saveId]?.game || validations[saveId]?.detection?.game || "—"}</div>
                <label>Generation</label>
                <div>{String(boxesBySave[saveId]?.generation ?? validations[saveId]?.detection?.generation ?? "—")}</div>
              </div>
              {boxesBySave[saveId]?.notes && <div className="small" style={{ marginTop: 8 }}>{boxesBySave[saveId]?.notes}</div>}
            </div>

            <div className="detail-card">
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Selection</div>
              {!selectedSlot ? (
                <div className="small">Click a slot in the grid.</div>
              ) : (
                <div className="kv">
                  <label>Box</label><div>{selectedSlot.box}</div>
                  <label>Slot</label><div>{selectedSlot.slot}</div>
                  {(() => {
                    const b = boxesBySave[saveId!]?.boxes?.[selectedSlot.box - 1];
                    const m = b?.mons?.[selectedSlot.slot - 1];
                    if (!m) return <></>;
                    if (m.empty) {
                      return (
                        <>
                          <label>Status</label><div>Empty</div>
                        </>
                      );
                    }
                    return (
                      <>
                        <label>Status</label><div>Occupied</div>
                        <label>Species</label>
                        <div>{m.species ? (nameCache[m.species] ?? `#${m.species}`) : "?"}</div>
                        <label>Nature</label><div>{m.nature ?? "?"}</div>
                        <label>Shiny</label><div>{m.shiny ? "★ Yes" : "No"}</div>
                        <label>PID</label><div className="small"><code>{m.pid}</code></div>
                        <label>TID/SID</label><div className="small"><code>{m.tid}/{m.sid}</code></div>
                        <label>Checksum</label><div>{m.checksumOK === true ? "OK" : m.checksumOK === false ? "Bad" : "—"}</div>
                        <label>Preview</label><div><code>{m.preview}</code></div>
                        <label>Hash</label><div className="small"><code>{m.hash}</code></div>
                        <label>Download</label>
                        <div>
                          <button
                            className="btn"
                            onClick={() => {
                              const url = `${API_BASE}/api/boxes/${encodeURIComponent(saveId!)}/export?box=${selectedSlot.box}&slot=${selectedSlot.slot}`;
                              window.open(url, "_blank");
                            }}
                          >
                            Download .pk6
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
            </div>

            <div className="detail-card">
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Actions</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn" onClick={() => saveId && validateSave(saveId)}>Re-Validate</button>
                <button className="btn" onClick={() => saveId && scanXY(saveId)}>Scan XY Region</button>
                <button className="btn warning" onClick={() => saveId && setXYOffset(saveId)}>Set XY Offset</button>
              </div>
              <div className="small" style={{ marginTop: 8 }}>
                Double-click a green tile to download its raw <code>.pk6</code> blob.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
