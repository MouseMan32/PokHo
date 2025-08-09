// api/parsers/gen6_xy.js
/**
 * Minimal Gen-6 (X/Y) parser scaffold for Citra "main" saves.
 * - Confirms expected size (0x65600) for your sample
 * - Returns trainer placeholders (to be implemented)
 * - Returns correct XY grid: 31 boxes × 30 slots
 *
 * Next steps (TODO):
 *  - Locate trainer block and read TID/SID/OT/gender
 *  - Locate box storage and extract PK6 blobs per slot
 *  - Compute species/level/shiny from PK6
 */

export const XY_EXPECTED_SIZE = 0x65600; // 415,232 bytes

export function isLikelyXYSav(buf) {
  return buf?.length === XY_EXPECTED_SIZE;
}

export function readMetadata(buf) {
  // TODO: implement actual header/blocks parsing for trainer data
  const ok = isLikelyXYSav(buf);
  return {
    ok,
    game: "Pokémon X/Y (Citra)",
    generation: 6,
    // placeholders until real parsing lands:
    trainer: {
      ot: "Unknown",    // TODO
      tid: null,        // TODO
      sid: null,        // TODO
      gender: "Unknown" // TODO
    },
    notes: ok
      ? "Detected XY Citra save by size (0x65600). Trainer details pending parser implementation."
      : "Unexpected size for XY (Citra). If this is still X/Y, please share another sample.",
  };
}

export function readBoxes(buf) {
  // XY has 31 boxes of 30 slots each
  const BOXES = 31;
  const SLOTS = 30;

  const boxes = Array.from({ length: BOXES }, (_, i) => ({
    id: `box-${i + 1}`,
    name: `Box ${i + 1}`,
    mons: Array.from({ length: SLOTS }, (_, j) => ({
      slot: j + 1,
      empty: true,       // TODO: replace with parsed PK6 data
      // When implemented, include: species, level, shiny, pid, etc.
    })),
  }));

  return {
    game: "Pokémon X/Y (Citra)",
    generation: 6,
    boxes,
    notes: "Layout only; PK6 parsing not implemented yet.",
  };
}
