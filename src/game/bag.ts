import type { Colour, Tile } from "./types";

/**
 * Canonical hedge set, taken from the corrected photo distribution.
 * 52 tiles total; every colour (G/Y/B/P) appears exactly 39 times
 * (4 × 39 = 156 = 52 × 3 segments).
 *
 * Breakdown: 12 "all-different-colour" designs appear ×2 (24 tiles),
 * 24 "pair+single" designs appear ×1, plus 4 monochrome triples ×1.
 */
const DOUBLES: string[] = [
  "BGP", "BGY", "BPG", "BPY", "BYP",
  "GBP", "GBY", "GYB", "GYP",
  "YBP", "YGP", "YPG",
];
const SINGLES: string[] = [
  // pair + single (24)
  "BBG", "BBP", "BBY", "BGB", "BPB", "BYB",
  "GBG", "GGB", "GGP", "GGY", "GPG", "GYG",
  "PBP", "PGP", "PPB", "PPG", "PPY", "PYP",
  "YBY", "YGY", "YPY", "YYB", "YYG", "YYP",
  // monochrome triples (4)
  "BBB", "GGG", "PPP", "YYY",
];
export const TILE_CODES: string[] = [
  ...DOUBLES.flatMap((c) => [c, c]),
  ...SINGLES,
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
