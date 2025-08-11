// web/src/speciesNames.ts
import { gen1, gen2, gen3, gen4, gen5, gen6 } from "./species";

// Merged map for Gen 1–6
export const speciesNames: Record<number, string> = {
  0: "", // empty
  ...gen1,
  ...gen2,
  ...gen3,
  ...gen4,
  ...gen5,
  ...gen6,
};

// Basic lookup with fallback
export function getSpeciesName(id: number): string {
  const s = speciesNames[id];
  return s && s.length ? s : `#${id}`;
}

// Small in-memory cache so repeated renders are cheap
const nameCache = new Map<number, string>();

export function getCachedName(id: number): string {
  if (nameCache.has(id)) return nameCache.get(id)!;
  const name = getSpeciesName(id);
  nameCache.set(id, name);
  return name;
}

// Async wrapper (kept for callers that `await` it)
export async function fetchSpeciesName(id: number): Promise<string> {
  return getCachedName(id);
}
