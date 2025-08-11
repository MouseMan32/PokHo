// web/src/speciesNames.ts
import { gen1, gen2, gen3, gen4, gen5, gen6 } from "./species";

export const speciesNames: Record<number, string> = {
  0: "", // empty slot
  ...gen1,
  ...gen2,
  ...gen3,
  ...gen4,
  ...gen5,
  ...gen6,
};

export function getSpeciesName(id: number): string {
  const s = speciesNames[id];
  return s && s.length ? s : `#${id}`;
}

