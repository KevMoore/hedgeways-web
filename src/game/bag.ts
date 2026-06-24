import type { Colour, Tile } from "./types";

/**
 * Canonical hedge set. Every physical tile is a 1×3 strip of three *different*
 * colours (G/Y/B/P) — there are 13 distinct designs (= 39 colour splodges),
 * each appearing 4× for 52 tiles total, exactly as in the box.
 */
const DESIGNS: string[] = [
  "PBG", "PYG", "PGB", "GYB", "GPB", "PYB", "GBY",
  "PBY", "PGY", "BGY", "BYG", "GPY", "BPY",
];
const COPIES = 4;
export const TILE_CODES: string[] = DESIGNS.flatMap((c) => Array(COPIES).fill(c));

function toTile(code: string, id: number): Tile {
  const seg = code.split("") as Colour[];
  if (seg.length !== 3 || seg.some((c) => !"GYBP".includes(c)))
    throw new Error(`bad tile code "${code}"`);
  return { id, segments: [seg[0], seg[1], seg[2]] };
}

export function buildBag(): Tile[] {
  return TILE_CODES.map(toTile);
}

export const BAG_SIZE = TILE_CODES.length;
