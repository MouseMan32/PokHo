// web/src/speciesNames.ts
// Tiny helper that fetches species names from PokéAPI and caches them in localStorage.

const LS_KEY = "species-name-cache-v1";

type Cache = Record<string, string>;

function readCache(): Cache {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeCache(cache: Cache) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cache));
  } catch {}
}

export function getCachedName(id: number): string | null {
  const cache = readCache();
  return cache[String(id)] ?? null;
}

export async function fetchSpeciesName(id: number, lang = "en"): Promise<string> {
  const cached = getCachedName(id);
  if (cached) return cached;

  try {
    const r = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${id}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const entry =
      (j.names as Array<{ name: string; language: { name: string } }>)
        ?.find((n) => n.language?.name === lang) ??
      null;

    const name = entry?.name || `#${id}`;
    const cache = readCache();
    cache[String(id)] = name;
    writeCache(cache);
    return name;
  } catch {
    return `#${id}`;
  }
}
