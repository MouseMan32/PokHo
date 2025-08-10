// api/parsers/gen6_xy.js
import crypto from "crypto";

export const XY_EXPECTED_SIZE = 0x65600;

export const XY = {
  BOXES: 31,
  SLOTS_PER_BOX: 30,
  SLOT_SIZE: 232,
};
const TOTAL_SLOTS = XY.BOXES * XY.SLOTS_PER_BOX;
const REGION_LEN = TOTAL_SLOTS * XY.SLOT_SIZE;

/**
 * Checks if the provided buffer matches the known size for XY (Citra) saves.
 */
export function isLikelyXYSav(buf) {
  return buf?.length === XY_EXPECTED_SIZE;
}

/**
 * Basic save metadata (only detection right now — no trainer info yet).
 */
export function readMetadata(buf) {
  const ok = isLikelyXYSav(buf);
  return {
    ok,
    game: "Pokémon X/Y (Citra)",
    generation: 6,
    trainer: { ot: "Unknown", tid: null, sid: null, gender: "Unknown" },
    notes: ok
      ? "Detected XY Citra save by size (0x65600). Trainer parsing will come next."
      : "Unexpected size for XY (Citra).",
  };
}

/**
 * Scan the buffer for possible box regions by counting non-empty slots.
 */
export function scanCandidates(buf, step = 0x100) {
  const out = [];
  if (!buf || buf.length < REGION_LEN) return out;
  for (let off = 0; off + REGION_LEN <= buf.length; off += step) {
    let nonZeroSlots = 0;
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const sOff = off + i * XY.SLOT_SIZE;
      let allZero = true;
      for (let j = 0; j < XY.SLOT_SIZE; j++) {
        if (buf[sOff + j] !== 0) { allZero = false; break; }
      }
      if (!allZero) nonZeroSlots++;
    }
    const score = nonZeroSlots / TOTAL_SLOTS;
    if (score > 0.03) out.push({ offset: off, nonZeroSlots, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 10);
}

/**
 * Finds the offset where the box data begins.
 */
export function findBoxRegion(buf, overrideOffset) {
  if (Number.isInteger(overrideOffset) &&
      overrideOffset >= 0 &&
      overrideOffset + REGION_LEN <= buf.length) {
    return { offset: overrideOffset, source: "override" };
  }
  const cands = scanCandidates(buf);
  if (cands.length) return { offset: cands[0].offset, source: "scan", candidates: cands };
  return { offset: null, source: "none" };
}

/**
 * Reads the box and slot structure from the save file.
 * Returns occupancy info, plus a preview hash for each occupied slot.
 */
export function readBoxes(buf, overrideOffset) {
  const region = findBoxRegion(buf, overrideOffset);
  if (region.offset == null) {
    return {
      game: "Pokémon X/Y (Citra)",
      generation: 6,
      boxes: [],
      notes: "Could not locate box region automatically. Set XY offset override.",
      debug: region.candidates ?? undefined
    };
  }

  const boxes = [];
  let ptr = region.offset;

  for (let b = 0; b < XY.BOXES; b++) {
    const mons = [];
    for (let s = 0; s < XY.SLOTS_PER_BOX; s++) {
      const slotBytes = buf.subarray(ptr, ptr + XY.SLOT_SIZE);

      // Check if slot is empty
      let allZero = true;
      for (let i = 0; i < XY.SLOT_SIZE; i++) {
        if (slotBytes[i] !== 0) { allZero = false; break; }
      }

      // If occupied, create small fingerprint + full SHA-1
      let preview = null, sha1 = null;
      if (!allZero) {
        preview = Buffer.from(slotBytes.subarray(0, 8)).toString("hex");
        sha1 = crypto.createHash("sha1").update(slotBytes).digest("hex");
      }

      mons.push({
        slot: s + 1,
        empty: allZero,
        preview,   // hex string of first 8 bytes
        hash: sha1 // full SHA-1 of 232b blob
      });

      ptr += XY.SLOT_SIZE;
    }
    boxes.push({ id: `box-${b + 1}`, name: `Box ${b + 1}`, mons });
  }

  return {
    game: "Pokémon X/Y (Citra)",
    generation: 6,
    boxes,
    notes: region.source === "override"
      ? `Using override offset 0x${region.offset.toString(16)}.`
      : `Guessed offset 0x${region.offset.toString(16)} via scan.`,
    debug: region.candidates ?? undefined
  };
}
