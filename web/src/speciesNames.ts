// web/src/speciesNames.ts
import { gen1 } from "./species";
import { gen2 } from "./species";
import { gen3 } from "./species";
import { gen4 } from "./species";
import { gen5 } from "./species";
import { gen6 } from "./species";

// merged map
export const speciesNames: Record<number, string> = {
  0: "",
  ...gen1, ...gen2, ...gen3, ...gen4, ...gen5, ...gen6,
};

// basic lookup with fallback
export function getSpeciesName(id: number): string {
  const s = speciesNames[id];
  return s && s.length ? s : `#${id}`;
}

// small in-memory cache so repeated renders are cheap
const nameCache = new Map<number, string>();

export function getCachedName(id: number): string {
  if (nameCache.has(id)) return nameCache.get(id)!;
  const name = getSpeciesName(id);
  nameCache.set(id, name);
  return name;
}

// kept async to match callers that `await` it; resolves immediately
export async function fetchSpeciesName(id: number): Promise<string> {
  return getCachedName(id);
}
