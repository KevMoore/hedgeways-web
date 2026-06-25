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

/** Tiles dealt into the bag per player — the bag scales with the table so each
 *  farmer gets the same material regardless of headcount. Validated by
 *  Monte-Carlo self-play in docs/bag-size-analysis.md. */
export const TILES_PER_PLAYER = 26;

/**
 * A colour-balanced 26-tile half of the canonical set — exactly half of every
 * count (12 tri / 12 pair / 2 mono) with segments G19 Y20 B19 P20 (imbalance 1,
 * the minimum possible for 78 segments). Used only for ODD player counts; even
 * counts stack whole canonical sets. Hardcoded for determinism (the AI rebuilds
 * the identical bag in ai.ts determinize). Found by balance search over the set.
 */
const HALF_SET: string[] = [
  "BGP", "BGY", "BPG", "BPY", "BYP", "GBP", "GBY", "GYB", "GYP", "YBP", "YGP", "YPG", // 12 tri
  "BBP", "BYB", "GGP", "GYG", "PBP", "PPB", "PPG", "PPY", "YGY", "YYB", "YYG", "YYP", // 12 pair
  "BBB", "GGG", // 2 mono
];

export const bagSizeFor = (players: number): number => Math.max(1, players) * TILES_PER_PLAYER;

/**
 * Build a bag scaled to the player count: 2p → 52, 3p → 78, 4p → 104 (26 tiles
 * per player). Even counts stack whole canonical sets; an odd count adds one
 * balanced HALF_SET. So a 2-player bag IS the original 52-tile set, and a
 * 4-player bag is exactly two of them. IDs are 0..size-1 and deterministic for a
 * given count, so the AI can reconstruct the unseen tiles (ai.ts determinize) by
 * rebuilding the identical bag. The bag is shuffled at deal time.
 */
export function buildBag(players = 2): Tile[] {
  const n = Math.max(1, players);
  const codes: string[] = [];
  for (let i = 0; i < Math.floor(n / 2); i++) codes.push(...TILE_CODES);
  if (n % 2 === 1) codes.push(...HALF_SET);
  return codes.map(toTile);
}

/** Size of the canonical 2-player set (52). Per-count size: see bagSizeFor(). */
export const BAG_SIZE = TILE_CODES.length;
