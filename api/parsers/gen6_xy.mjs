// api/parsers/gen6_xy.mjs
import crypto from "crypto";

/* ============================ XY save & PK6 layout ============================ */

export const XY_EXPECTED_SIZES = [0x65600, 0x65800]; // 415,232 and 415,744 bytes

export const XY = {
  BOXES: 31,
  SLOTS_PER_BOX: 30,
  SLOT_SIZE: 232, // 0xE8 bytes per pk6
};

/* -------------------------- Helpers: RNG + block order ------------------------ */

// GameFreak LCRNG (used for PK6 keystream)
function lcrng_next(seed) {
  // (seed * 0x41C64E6D + 0x6073) mod 2^32
  return (Math.imul(seed, 0x41c64e6d) + 0x6073) >>> 0;
}

// 24-permutation table for (A,B,C,D) shuffling (Gen 3/4/5/6)
const ORDERS = [
  [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 2, 3, 1], [0, 3, 1, 2], [0, 3, 2, 1],
  [1, 0, 2, 3], [1, 0, 3, 2], [2, 0, 1, 3], [3, 0, 1, 2], [1, 2, 0, 3], [1, 3, 0, 2],
  [2, 1, 0, 3], [3, 1, 0, 2], [2, 1, 3, 0], [3, 1, 2, 0], [2, 3, 0, 1], [3, 2, 0, 1],
  [1, 2, 3, 0], [1, 3, 2, 0], [2, 3, 1, 0], [3, 2, 1, 0], [3, 0, 2, 1], [2, 0, 3, 1],
];

/* ----------------------------- Core PK6 primitives ---------------------------- */

// Decrypt the 224-byte payload (after 8-byte header) using EC-seeded LCRNG
function decrypt224(enc224, ec) {
  const out = Buffer.allocUnsafe(224);
  let seed = ec >>> 0;
  for (let i = 0; i < 224; i += 2) {
    seed = lcrng_next(seed);
    const key = (seed >>> 16) & 0xffff;
    const w = enc224.readUInt16LE(i) ^ key;
    out.writeUInt16LE(w, i);
  }
  return out;
}

// Rearrange 4×56-byte blocks back into logical A,B,C,D order
function unshuffleBlocks(decrypted224, ec) {
  const blocks = [
    decrypted224.subarray(0, 56),
    decrypted224.subarray(56, 112),
    decrypted224.subarray(112, 168),
    decrypted224.subarray(168, 224),
  ];
  const order = ORDERS[Math.abs(ec % 24)];
  const out = Buffer.allocUnsafe(224);
  let p = 0;
  // place logical A(0),B(1),C(2),D(3) in order
  for (let logical = 0; logical < 4; logical++) {
    const from = order.indexOf(logical);
    blocks[from].copy(out, p);
    p += 56;
  }
  return out;
}

// Little-endian 16-bit checksum of 224 bytes
function sum16le(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    sum = (sum + buf.readUInt16LE(i)) & 0xffff;
  }
  return sum & 0xffff;
}

/* ----------------------------- Slot decode (PK6) ----------------------------- */
/**
 * Minimal decode of a single 232-byte PK6 slice.
 * Returns: { checksumOK, species, nature, pid, tid, sid, shiny, preview, hash }
 */
function decodePK6(slotBuf) {
  if (!slotBuf || slotBuf.length < XY.SLOT_SIZE) return null;

  const ec = slotBuf.readUInt32LE(0x00);
  const checksum = slotBuf.readUInt16LE(0x04);
  const enc224 = slotBuf.subarray(0x08, 0x08 + 224);

  const dec = decrypt224(enc224, ec);
  const data = unshuffleBlocks(dec, ec);

  const calc = sum16le(data);
  const checksumOK = calc === checksum;

  // PK6: Growth block at start of unshuffled data
  const pid = data.readUInt32LE(0x00);
  const species = data.readUInt16LE(0x08);      // species dex id
  const nature = data.readUInt8(0x1c);          // 0..24
  // Trainer IDs (Gen6 uses 32-bit, stored as two 16-bit halves)
  const tid = data.readUInt16LE(0x0c);
  const sid = data.readUInt16LE(0x0e);

  // Shiny check (XOR of halves)
  const shinyXor = ((pid & 0xffff) ^ (pid >>> 16) ^ tid ^ sid) & 0xffff;
  const shiny = shinyXor < 16;

  const preview = `PID=${pid.toString(16)} SPEC=${species} NAT=${nature}`;
  const hash = crypto.createHash("sha1").update(slotBuf).digest("hex").slice(0, 12);

  return { checksumOK, species, nature, pid, tid, sid, shiny, preview, hash };
}

// Expose for the rest of the code
XY.decodeSlot = decodePK6;

/* ----------------------------- Save shape helpers ---------------------------- */

export function isLikelyXYSav(buf) {
  return !!buf && XY_EXPECTED_SIZES.includes(buf.length);
}

function isAllZero(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

/* -------------------------- Region finding & scoring ------------------------- */

// Full scorer: checks all 31*30 slots
export function scoreXYRegion(buf, offset) {
  const totalSlots = XY.BOXES * XY.SLOTS_PER_BOX;
  const size = XY.SLOT_SIZE;

  let ok = 0, zeros = 0, bad = 0, shinyCount = 0, plausibleSpecies = 0;

  for (let i = 0; i < totalSlots; i++) {
    const start = offset + i * size;
    const end = start + size;
    if (end > buf.length) { bad += (totalSlots - i); break; }

    const slice = buf.subarray(start, end);

    if (isAllZero(slice)) { zeros++; continue; }

    let d = null;
    try { d = decodePK6(slice); } catch { d = null; }

    if (d && d.checksumOK === true) {
      ok++;
      if (d.shiny) shinyCount++;
      if (typeof d.species === "number" && d.species >= 1 && d.species <= 721) plausibleSpecies++;
    } else {
      bad++;
    }
  }

  // Weighted score: reward valid checksums & plausible species; penalize bads
  const score = (ok * 2) + (plausibleSpecies * 1) + (shinyCount * 0.25) - (bad * 0.5);
  return { score, ok, zeros, bad, plausibleSpecies, shinyCount };
}

// Fast sample scorer for coarse scans
function scoreXYRegionFast(buf, offset, { sampleStride = 12, badEarlyOut = 30 } = {}) {
  const size = XY.SLOT_SIZE;
  const totalSlots = XY.BOXES * XY.SLOTS_PER_BOX;

  let ok = 0, bad = 0, plausibleSpecies = 0;

  for (let i = 0; i < totalSlots; i += sampleStride) {
    const start = offset + i * size;
    const end = start + size;
    if (end > buf.length) { bad += 5; break; } // heavy penalty if OOB
    const slice = buf.subarray(start, end);

    // quick non-zero test
    let nz = false;
    for (let j = 0; j < slice.length; j++) { if (slice[j] !== 0) { nz = true; break; } }
    if (!nz) continue;

    let d = null;
    try { d = decodePK6(slice); } catch {}

    if (d && d.checksumOK === true) {
      ok++;
      if (typeof d.species === "number" && d.species >= 1 && d.species <= 721) plausibleSpecies++;
    } else {
      bad++;
      if (bad >= badEarlyOut) break;
    }
  }
  return { score: ok * 2 + plausibleSpecies * 1 - bad * 0.5, ok, bad, plausibleSpecies };
}

// Brute-force around a hint with fast+full refinement (best for autofix)
export function xyAutoPickOffsetFast(buf, hint) {
  const base = Number(hint || 0);
  const bases = [base, base + 0x200, base - 0x200]; // handle size skew

  const coarse = [];
  for (const h of bases) {
    for (let d = -0x4000; d <= 0x4000; d += 0x80) { // coarse stride
      const off = h + d;
      if (off < 0 || off >= buf.length) continue;
      const r = scoreXYRegionFast(buf, off, { sampleStride: 12, badEarlyOut: 30 });
      coarse.push({ offset: off, coarse: r });
    }
  }
  // shortlist
  coarse.sort((a, b) => b.coarse.score - a.coarse.score);
  const shortlist = coarse.slice(0, 15);

  // refine with full scorer
  const refined = shortlist.map(c => {
    const full = scoreXYRegion(buf, c.offset);
    return { offset: c.offset, full };
  }).sort((a, b) => b.full.score - a.full.score || a.full.bad - b.full.bad);

  const best = refined[0] || null;
  return { best: best ? { offset: best.offset, ...best.full } : null, top: refined.slice(0, 10) };
}

// Legacy autopick (full brute around hint) – still exported if you want it
export function xyAutoPickOffset(buf, hint) {
  const candidates = new Map(); // offset -> result
  const push = (off, reason) => {
    if (off < 0 || off >= buf.length) return;
    if (candidates.has(off)) return;
    const r = scoreXYRegion(buf, off);
    candidates.set(off, { offset: off, reason, ...r });
  };

  const base = Number(hint || 0);
  const baseHints = [base, base + 0x200, base - 0x200];

  for (const h of baseHints) {
    for (let d = -0x4000; d <= 0x4000; d += 0x10) {
      push(h + d, (h === base ? "hint" : (h > base ? "+0x200" : "-0x200")));
    }
  }

  const top = Array.from(candidates.values())
    .sort((a, b) => b.score - a.score || a.bad - b.bad);

  return { best: top[0], top };
}

/* ----------------------------- Public XY helpers ---------------------------- */

// Coarse scan to surface promising regions (used by /debug/xy/:id/scan)
function scanCandidates(buf) {
  const step = 0x100; // coarse stride
  const max = Math.max(0, buf.length - XY.SLOT_SIZE * XY.BOXES * XY.SLOTS_PER_BOX);
  const results = [];

  for (let off = 0; off <= max; off += step) {
    const r = scoreXYRegionFast(buf, off, { sampleStride: 10, badEarlyOut: 30 });
    if (r.ok >= 8 && r.score > 8) {
      results.push({ offset: off, ...r });
    }
  }

  results.sort((a, b) => b.score - a.score || a.bad - b.bad);
  return results.slice(0, 25);
}

export function findBoxRegion(buf, overrideOffset) {
  if (Number.isInteger(overrideOffset) && overrideOffset >= 0) {
    return { offset: Number(overrideOffset), debug: [{ offset: Number(overrideOffset), note: "override" }] };
  }
  // try a broad scan; if empty, widen by trying ±0x200 around a common seed
  let cands = scanCandidates(buf);
  if (!cands.length) {
    const seeds = [0x22600, 0x22600 + 0x200, 0x22600 - 0x200];
    for (const s of seeds) {
      for (let d = -0x4000; d <= 0x4000; d += 0x80) {
        const off = s + d;
        if (off < 0) continue;
        const r = scoreXYRegionFast(buf, off, { sampleStride: 12, badEarlyOut: 30 });
        if (r.ok >= 6 && r.score > 6) cands.push({ offset: off, ...r });
      }
    }
    cands.sort((a, b) => b.score - a.score || a.bad - b.bad);
    cands = cands.slice(0, 25);
  }
  const best = cands[0] || null;
  return { offset: best ? best.offset : null, debug: cands };
}

/* ----------------------------- Metadata & Boxes ----------------------------- */

export function readMetadata(_buf) {
  // Minimal placeholder; extend if/when you decode trainer data
  return { trainer: null };
}

export function readBoxes(buf, overrideOffset) {
  const region = findBoxRegion(buf, overrideOffset);
  const off = region.offset;
  const boxes = [];

  if (off == null) {
    return {
      game: "Pokémon X/Y (Citra)",
      generation: "6",
      boxes: [],
      notes: "XY region not found. Try scanning or setting an offset.",
      debug: region.debug,
      region,
      offset: null,
    };
  }

  const isValidMon = (d) =>
    !!d &&
    d.checksumOK === true &&
    typeof d.species === "number" &&
    d.species >= 1 &&
    d.species <= 721 &&
    typeof d.pid === "number" &&
    d.pid !== 0;

  let lastNonEmptyBox = -1;

  for (let b = 0; b < XY.BOXES; b++) {
    const mons = [];
    let boxHasMon = false;

    for (let s = 0; s < XY.SLOTS_PER_BOX; s++) {
      const idx = b * XY.SLOTS_PER_BOX + s;
      const start = off + idx * XY.SLOT_SIZE;
      const end = start + XY.SLOT_SIZE;

      if (end > buf.length) {
        mons.push({ slot: s + 1, empty: true });
        continue;
      }

      const slice = buf.subarray(start, end);

      // quick zero check
      let nonzero = false;
      for (let j = 0; j < slice.length; j++) { if (slice[j] !== 0) { nonzero = true; break; } }
      if (!nonzero) {
        mons.push({ slot: s + 1, empty: true });
        continue;
      }

      const d = XY.decodeSlot(slice);

      if (isValidMon(d)) {
        boxHasMon = true;
        mons.push({
          slot: s + 1,
          empty: false,
          species: d.species,
          nature: d.nature ?? null,
          shiny: !!d.shiny,
          pid: d.pid,
          tid: d.tid ?? null,
          sid: d.sid ?? null,
          checksumOK: true,
          preview: d.preview,
          hash: d.hash,
        });
      } else {
        // Treat invalid/garbage as empty so we don't “fill” boxes
        mons.push({ slot: s + 1, empty: true });
      }
    }

    if (boxHasMon) lastNonEmptyBox = b;
    boxes.push({ id: `box-${b + 1}`, name: `Box ${String(b + 1).padStart(2, "0")}`, mons });
  }

  // Trim trailing all-empty boxes (keep at least 1 to show the grid)
  const trimmed =
    lastNonEmptyBox >= 0 ? boxes.slice(0, lastNonEmptyBox + 1) : boxes.slice(0, 1);

  return {
    game: "Pokémon X/Y (Citra)",
    generation: "6",
    boxes: trimmed,
    notes:
      lastNonEmptyBox >= 0
        ? `Showing ${trimmed.length} box(es).`
        : "No valid Pokémon found in boxes."
        ,
    debug: region.debug,
    region,
    offset: off,
  };
}
