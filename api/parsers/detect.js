import path from "path";

const PKM_EXTS = new Set(["pk1","pk2","pk3","pk4","pk5","pk6","pk7","pk8","pk9","pb7","pb8"]);

/**
 * Heuristic detector (incremental).
 * - Classifies individual Pokémon files by extension (lowest risk first).
 * - Treats 3DS/NS "main" saves as generic saves for now; user can override in UI.
 * - Returns a confidence so UI can show “Unknown – choose game”.
 */
export function detectFormat(buf, filename) {
  const size = buf.length;
  const ext = path.extname(filename || "").toLowerCase().replace(".","");
  const base = path.basename(filename || "").toLowerCase();

  // 1) Obvious: single-Pokémon files by extension
  if (PKM_EXTS.has(ext)) {
    return {
      kind: "pokemon-file",
      game: guessGameFromExt(ext), // e.g., pk6 -> Gen 6
      generation: guessGenFromExt(ext),
      confidence: 0.98,
      notes: `Detected by extension .${ext}`,
    };
  }

  // 2) Heuristics for Citra/JKSV/Checkpoint "main" saves
  if (base === "main") {
    // Known X/Y (Citra) sample we have: 0x65600 (415,232 bytes)
    if (size === 0x65600) {
      return {
        kind: "save",
        game: "Pokémon X/Y (Citra)",
        generation: 6,
        confidence: 0.95,
        notes: "Citra-style 'main' with size 0x65600 matches known XY layout.",
      };
    }

    // Future: add more known sizes for OR/AS, SM/USUM, etc.
    return {
      kind: "save",
      game: "unknown",
      generation: "unknown",
      confidence: 0.6,
      notes: "File named 'main' (likely Citra/3DS/Switch save). Use 'Set Game' if not auto-detected.",
    };
  }

  // 3) Fallback
  return {
    kind: "unknown",
    game: "unknown",
    generation: "unknown",
    confidence: 0.1,
    notes: `Unrecognized file ${filename} (${size} bytes).`,
  };
}

function genFromExt(ext) {
  if (ext.startsWith("pk")) {
    const n = Number(ext.replace("pk",""));
    if (!Number.isNaN(n)) return n;
  }
  if (ext.startsWith("pb")) return 7; // HOME/Bank bridge context ~ Gen 7+
  return "unknown";
}
function gameFromGen(g) {
  if (g === 6) return "Gen 6 title (e.g., X/Y, OR/AS)";
  if (g === 7) return "Gen 7 title (e.g., SM/USUM, LGPE)";
  if (g === 8) return "Gen 8 title (e.g., Sw/Sh, BDSP, PLA)";
  if (g === 9) return "Gen 9 title (e.g., SV)";
  return "unknown";
}
