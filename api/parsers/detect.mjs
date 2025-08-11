// api/parsers/detect.mjs
import { XY_EXPECTED_SIZES } from "./gen6_xy.mjs";

export function detectFormat(buf, filename = "") {
  const name = (filename || "").toLowerCase().trim();

  // Single-Pokémon files (quick pass-through)
  if (/\.(pk[1-9]|pb[78])$/.test(name)) {
    return {
      kind: "single-pokemon",
      game: "Single Pokémon blob",
      generation: "unknown",
      confidence: 0.95,
      notes: "Detected by file extension",
    };
  }

  // Pokémon X/Y (Citra/JKSV) saves: two common sizes
  if (buf && XY_EXPECTED_SIZES.includes(buf.length)) {
    return {
      kind: "citra-xy",
      game: "Pokémon X/Y (Citra)",
      generation: "6",
      confidence: 0.9,
      notes: `Detected by XY save size (${buf.length} bytes)`,
    };
  }

  // Unknown (fallback)
  return {
    kind: "unknown",
    game: "unknown",
    generation: "unknown",
    confidence: 0.2,
    notes: "No known signature matched",
  };
}
