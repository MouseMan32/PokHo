// Very simple detector so the API can run.
// We recognize Citra XY saves by size; otherwise "unknown".
export function detectFormat(buf, filename = "") {
  const XY_EXPECTED_SIZE = 0x65600; // 415,744
  const looksXY = buf?.length === XY_EXPECTED_SIZE;
  return {
    kind: looksXY ? "citra-xy" : "unknown",
    game: looksXY ? "Pokémon X/Y (Citra)" : "unknown",
    generation: looksXY ? "6" : "unknown",
    confidence: looksXY ? 0.9 : 0.2,
    notes: looksXY ? "Detected by XY Citra save size (0x65600)" : "No match",
  };
}
