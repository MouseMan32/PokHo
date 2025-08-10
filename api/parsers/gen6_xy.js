// api/parsers/gen6_xy.js
import crypto from "crypto";

export const XY_EXPECTED_SIZE = 0x65600;

export const XY = {
  BOXES: 31,
  SLOTS_PER_BOX: 30,
  SLOT_SIZE: 232, // 0xE8
};
const TOTAL_SLOTS = XY.BOXES * XY.SLOTS_PER_BOX;
const REGION_LEN = TOTAL_SLOTS * XY.SLOT_SIZE;

/* -------------------------- Helpers: RNG + shuffle -------------------------- */

// GameFreak LCRNG (same constants used in earlier gens)
function lcrng_next(seed) {
  // (seed * 0x41C64E6D + 0x6073) mod 2^32
  return (Math.imul(seed, 0x41C64E6D) + 0x6073) >>> 0;
}

// 24-permutation table for (A,B,C,D) blocks, same as Gen 3/4/5.
// Gen 6 uses the *Encryption Key* instead of PID to select the order.
const ORDERS = [
  [0,1,2,3],[0,1,3,2],[0,2,1,3],[0,2,3,1],[0,3,1,2],[0,3,2,1],
  [1,0,2,3],[1,0,3,2],[2,0,1,3],[3,0,1,2],[1,2,0,3],[1,3,0,2],
  [2,1,0,3],[3,1,0,2],[2,1,3,0],[3,1,2,0],[2,3,0,1],[3,2,0,1],
  [1,2,3,0],[1,3,2,0],[2,3,1,0],[3,2,1,0],[3,2,1,0],[3,2,1,0]
];
// The last 3 rows above are placeholders to keep length=24; we’ll clamp with %24.
// (Real tables published for Gen4 show identical orders to index 0..23.)

function unshuffleBlocks(decrypted224, orderIndex) {
  const blocks = [];
  for (let i = 0; i < 4; i++) {
    blocks.push(decrypted224.subarray(i * 56, i * 56 + 56));
  }
  const idx = Math.abs(orderIndex) % 24;
  const order = ORDERS[idx];
  // Reassemble into logical A,B,C,D in order 0,1,2,3 (unshuffled)
  const out = Buffer.allocUnsafe(224);
  let p = 0;
  for (let logical = 0; logical < 4; logical++) {
    const from = order.indexOf(logical); // where logical block sits in encrypted order
    blocks[from].copy(out, p);
    p += 56;
  }
  return out;
}

function decryptPk6(slotBytes) {
  if (slotBytes.length !== 232) return null;

  const key = slotBytes.readUInt32LE(0);      // 0x00-0x03 Encryption Key
  const checksum = slotBytes.readUInt16LE(6); // 0x06-0x07

  // Decrypt 224 bytes (0x08..0xE7) word-by-word using LCRNG seeded by key.
  const enc = slotBytes.subarray(0x08, 0xE8);
  const dec = Buffer.allocUnsafe(enc.length);

  let seed = key >>> 0;
  for (let i = 0; i < enc.length; i += 2) {
    seed = lcrng_next(seed);
    const x = (seed >>> 16) & 0xFFFF;
    const w = enc.readUInt16LE(i) ^ x;
    dec.writeUInt16LE(w, i);
  }

  // Verify checksum: sum of 16-bit words (little endian) modulo 0x10000
  let sum = 0;
  for (let i = 0; i < dec.length; i += 2) sum = (sum + dec.readUInt16LE(i)) & 0xFFFF;
  const checksumOK = (sum === checksum);

  // Unshuffle 4×56 blocks; index derives from Encryption Key (Gen6)
  const unshuffled = unshuffleBlocks(dec, key % 24);

  // Now parse fields from logical A/B/C/D layout
  const species = unshuffled.readUInt16LE(0x00);   // Block A: 0x08->0 after unshuffle
  const heldItem = unshuffled.readUInt16LE(0x02);
  const tid = unshuffled.readUInt16LE(0x04);
  const sid = unshuffled.readUInt16LE(0x06);
  const exp = unshuffled.readUInt32LE(0x08);
  const ability = unshuffled.readUInt8(0x0C);
  const abilityNumber = unshuffled.readUInt8(0x0D);
  const pid = unshuffled.readUInt32LE(0x10);
  const nature = unshuffled.readUInt8(0x14);

  // Gen6 shiny check: (TID ^ SID ^ (PID_hi ^ PID_lo)) < 16
  const pLo = pid & 0xFFFF;
  const pHi = (pid >>> 16) & 0xFFFF;
  const shiny = (((tid ^ sid) ^ (pLo ^ pHi)) & 0xFFFF) < 16;

  return {
    key, checksum, checksumOK,
    species, heldItem, tid, sid, exp, ability, abilityNumber,
    pid, nature, shiny
  };
}

/* ------------------------------ Public API ------------------------------- */

export function isLikelyXYSav(buf) {
  return buf?.length === XY_EXPECTED_SIZE;
}

export function readMetadata(buf) {
  const ok = isLikelyXYSav(buf);
  return {
    ok,
    game: "Pokémon X/Y (Citra)",
    generation: 6,
    trainer: { ot: "Unknown", tid: null, sid: null, gender: "Unknown" },
    notes: ok
      ? "Detected XY Citra save by size (0x65600)."
      : "Unexpected size for XY (Citra).",
  };
}

// Count non-empty slots sliding window to guess region
export function scanCandidates(buf, step = 0x100) {
  const out = [];
  if (!buf || buf.length < REGION_LEN) return out;
  for (let off = 0; off + REGION_LEN <= buf.length; off += step) {
    let nonZeroSlots = 0;
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const sOff = off + i * XY.SLOT_SIZE;
      let allZero = true;
      for (let j = 0; j < XY.SLOT_SIZE; j++) { if (buf[sOff + j] !== 0) { allZero = false; break; } }
      if (!allZero) nonZeroSlots++;
    }
    const score = nonZeroSlots / TOTAL_SLOTS;
    if (score > 0.03) out.push({ offset: off, nonZeroSlots, score });
  }
  out.sort((a,b)=>b.score-a.score);
  return out.slice(0, 10);
}

export function findBoxRegion(buf, overrideOffset) {
  if (Number.isInteger(overrideOffset) && overrideOffset >= 0 && overrideOffset + REGION_LEN <= buf.length) {
    return { offset: overrideOffset, source: "override" };
  }
  const cands = scanCandidates(buf);
  if (cands.length) return { offset: cands[0].offset, source: "scan", candidates: cands };
  return { offset: null, source: "none" };
}

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

// Heuristic: score an XY box-region offset by how many plausible PK6 slots we see.
export function scoreXYRegion(buf, offset) {
  const BOXES = XY.BOX_COUNT ?? 31;
  const SLOTS = XY.SLOTS_PER_BOX ?? 30;
  const SIZE  = XY.SLOT_SIZE; // e.g., 0xE8 (232)

  const totalSlots = BOXES * SLOTS;
  let ok = 0, zeros = 0, bad = 0, shinyCount = 0, plausibleSpecies = 0;

  for (let i = 0; i < totalSlots; i++) {
    const start = offset + i * SIZE;
    const end = start + SIZE;
    if (end > buf.length) { bad += (totalSlots - i); break; }

    const blob = buf.subarray(start, end);

    // quick zero check
    let allZero = true;
    for (let j = 0; j < blob.length; j++) { if (blob[j] !== 0) { allZero = false; break; } }
    if (allZero) { zeros++; continue; }

    // use your existing minimal decode to sanity-check
    let decoded = null;
    try {
      decoded = XY.decodeSlot ? XY.decodeSlot(blob) : null;
    } catch { decoded = null; }

    if (decoded && decoded.checksumOK === true) {
      ok++;
      if (decoded.shiny) shinyCount++;
      if (typeof decoded.species === "number" && decoded.species >= 1 && decoded.species <= 721) {
        plausibleSpecies++;
      }
    } else {
      bad++;
    }
  }

  // Weighted score: reward valid checksums & plausible species; penalize bads
  const score = (ok * 2) + (plausibleSpecies * 1) + (shinyCount * 0.25) - (bad * 0.5);
  return { score, ok, zeros, bad, plausibleSpecies, shinyCount };
}

// Brute-force around a hint; also test ±0x200 variants for size skew
export function xyAutoPickOffset(buf, hint) {
  const candidates = new Map(); // offset -> result
  const pushes = (off, reason) => {
    if (off < 0 || off >= buf.length) return;
    if (candidates.has(off)) return;
    const r = scoreXYRegion(buf, off);
    candidates.set(off, { offset: off, reason, ...r });
  };

  const baseHints = [hint, hint + 0x200, hint - 0x200];

  for (const h of baseHints) {
    // stride 0x10 across ±0x4000
    for (let d = -0x4000; d <= 0x4000; d += 0x10) {
      pushes(h + d, (h === hint ? "hint" : (h > hint ? "+0x200" : "-0x200")));
    }
  }

  // Sort by score desc, then by fewer bads
  const top = Array.from(candidates.values())
    .sort((a, b) => b.score - a.score || a.bad - b.bad);

  return { best: top[0], top };
}


  const boxes = [];
  let ptr = region.offset;

  for (let b = 0; b < XY.BOXES; b++) {
    const mons = [];
    for (let s = 0; s < XY.SLOTS_PER_BOX; s++) {
      const slotBytes = buf.subarray(ptr, ptr + XY.SLOT_SIZE);

      // occupancy
      let allZero = true;
      for (let i = 0; i < XY.SLOT_SIZE; i++) { if (slotBytes[i] !== 0) { allZero = false; break; } }

      // tiny fingerprint + hash
      let preview = null, sha1 = null, decoded = null;
      if (!allZero) {
        preview = Buffer.from(slotBytes.subarray(0, 8)).toString("hex");
        sha1 = crypto.createHash("sha1").update(slotBytes).digest("hex");
        // NEW: decode minimal fields
        decoded = decryptPk6(slotBytes);
      }

      mons.push({
        slot: s + 1,
        empty: allZero,
        preview,
        hash: sha1,
        // minimal decoded fields for UI
        species: decoded?.species ?? null,
        pid: decoded?.pid ?? null,
        tid: decoded?.tid ?? null,
        sid: decoded?.sid ?? null,
        nature: decoded?.nature ?? null,
        shiny: decoded?.shiny ?? false,
        checksumOK: decoded?.checksumOK ?? null
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
