import type { GameSnapshot } from "./game";
import type { Tile } from "./types";

/**
 * Per-seat redaction for online play. The server holds the ONE true snapshot;
 * before sending it to a given seat it strips everything that seat must not see:
 *
 *   1. config.seed      — the bag order is shuffle(buildBag(n), makeRng(seed)),
 *                         so the seed alone reconstructs the whole bag AND every
 *                         hand. The single most dangerous leak.
 *   2. the bag contents — replaced by a same-length run of identical placeholders
 *                         (count is public; order/identity is not).
 *   3. other seats' hands — same treatment: count public, contents hidden.
 *
 * The result is a *valid* GameSnapshot (same shape, correct array lengths) so the
 * client can feed it straight to Game.load / applySnapshot. Because every hidden
 * tile becomes the SAME placeholder, the redaction is a pure function of counts —
 * it reveals nothing about the concealed tiles, by construction.
 */

/** A single, content-free stand-in for any concealed tile. Negative id so it can
 *  never collide with a real bag tile (ids are 0..bagSize-1) and is trivially
 *  recognisable in tests. All placeholders are identical → zero information. */
export const PLACEHOLDER_TILE: Readonly<Tile> = Object.freeze({
  id: -1,
  segments: ["G", "G", "G"],
}) as Tile;

export const isPlaceholder = (t: Tile): boolean => t.id < 0;

const placeholders = (n: number): Tile[] =>
  Array.from({ length: n }, () => ({ id: -1, segments: ["G", "G", "G"] as Tile["segments"] }));

const cloneTile = (t: Tile): Tile => ({ id: t.id, segments: [...t.segments] });

/** Redact a full snapshot down to what `seat` is allowed to see. Pure. */
export function redactFor(snap: GameSnapshot, seat: number): GameSnapshot {
  return {
    ...snap,
    config: {
      players: snap.config.players.map((p) => ({ ...p })),
      // seed deliberately omitted — see file header (1).
    },
    cells: snap.cells.map(([k, c]) => [k, { ...c }]),
    enclosed: [...snap.enclosed],
    acreOwner: [...snap.acreOwner],
    bag: placeholders(snap.bag.length),
    players: snap.players.map((p, i) => ({
      ...p,
      hand: i === seat ? p.hand.map(cloneTile) : placeholders(p.hand.length),
    })),
  };
}
