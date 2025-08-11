import { gen1 } from "./species/gen1";
import { gen2 } from "./species/gen2";
import { gen3 } from "./species/gen3";
import { gen4 } from "./species/gen4";
import { gen5 } from "./species/gen5";
import { gen6 } from "./species/gen6";

// Merge maps (later gens override earlier if a key duplicates)
export const speciesNames: Record<number, string> = {
  0: "", // empty slot
  ...gen1,
  ...gen2,
  ...gen3,
  ...gen4,
  ...gen5,
  ...gen6,
};

// Safe helper
export function getSpeciesName(id: number): string {
  const s = speciesNames[id];
  return s && s.length ? s : `#${id}`;
}
