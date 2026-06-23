import type { Colour, Tile } from "./types";

/**
 * Canonical hedge set, read from the two physical tile photos.
 * Each string is the three segment colours (G/Y/B/P) in tile order.
 *
 * NOTE: transcribed by eye from the photos — VERIFY against the real set and
 * correct any misreads here; this is the single source of truth for the bag.
 * 52 tiles total (photo 1: 28, photo 2: 24).
 */
export const TILE_CODES: string[] = [
  // -- photo 1, row 1 (8)
  "BGG", "GYY", "BPP", "PBB", "GBG", "YBY", "BPP", "BBB",
  // -- photo 1, row 2 (8)
  "PGG", "YYG", "YPB", "BBP", "PGP", "YBY", "PPY", "BYB",
  // -- photo 1, row 3 (8)
  "YGG", "YYP", "GPP", "BBB", "YGY", "YGY", "PGB", "BGB",
  // -- photo 1, row 4 (4)
  "GGG", "YYY", "PPP", "BBB",
  // -- photo 2, row 1 (4)
  "PBG", "PBG", "PYG", "PYG",
  // -- photo 2, row 2 (8)
  "PGB", "PGB", "GYB", "GYB", "GPB", "GPB", "PYB", "PYB",
  // -- photo 2, row 3 (12)
  "GBY", "GBY", "PBY", "PGY", "PGY", "PGY", "BGY", "BYG", "GPY", "GPY", "BPY", "BPY",
];

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
