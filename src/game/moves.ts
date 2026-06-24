import { Board, DIRS, isPalindrome, orient } from "./board";
import { validateMove } from "./placement";
import type { Move, Orientation, PlacedTile, Tile } from "./types";
import { key } from "./types";

const ORIENTS: Orientation[] = ["H", "V"];

/** Canonical signature of a move's footprint (for dedupe). */
function moveKey(tiles: PlacedTile[]): string {
  const cells: string[] = [];
  for (const t of tiles) for (const c of t.cells) cells.push(`${c.x},${c.y}:${c.colour}`);
  cells.sort();
  return cells.join("|");
}

/** Empty cells orthogonally adjacent to any cell in `cells`, excluding blocked. */
function frontier(cells: Iterable<string>, blocked: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number);
    for (const [dx, dy] of DIRS) {
      const nk = key(x + dx, y + dy);
      if (!blocked.has(nk)) out.add(nk);
    }
  }
  return out;
}

/**
 * All placements of one tile such that it covers `anchorCell` with one of its
 * three segments, in any orientation/flip, with every covered cell free.
 */
function placementsCovering(tile: Tile, anchorCell: string, blocked: Set<string>): PlacedTile[] {
  const [ax, ay] = anchorCell.split(",").map(Number);
  const out: PlacedTile[] = [];
  const flips = isPalindrome(tile) ? [false] : [false, true];
  for (const dir of ORIENTS) {
    const [dx, dy] = dir === "H" ? [1, 0] : [0, 1];
    for (const flip of flips) {
      for (let i = 0; i < 3; i++) {
        const cells = orient(tile, ax - dx * i, ay - dy * i, dir, flip);
        if (cells.every((c) => !blocked.has(key(c.x, c.y)))) {
          out.push({ tileId: tile.id, cells });
        }
      }
    }
  }
  return out;
}

/** First-move placements for one tile, anchored at the origin (board is translation-free). */
function originPlacements(tile: Tile): PlacedTile[] {
  const out: PlacedTile[] = [];
  const flips = isPalindrome(tile) ? [false] : [false, true];
  for (const dir of ORIENTS) for (const flip of flips) out.push({ tileId: tile.id, cells: orient(tile, 0, 0, dir, flip) });
  return out;
}

export interface GenOptions {
  maxLay?: number;
  /** Cap on number of moves returned (best-effort breadth limit for the AI). */
  limit?: number;
  /** effort cap: stop the search after this many candidate placements are tried.
   * Prevents pathological full enumeration on large, colour-constrained boards
   * where fewer than `limit` legal moves exist. */
  maxNodes?: number;
}

/** Enumerate all legal turns (lay 1..maxLay colour-linked tiles). */
export function generateMoves(board: Board, hand: Tile[], opts: GenOptions = {}): Move[] {
  const maxLay = Math.min(opts.maxLay ?? 3, hand.length);
  const limit = opts.limit ?? Infinity;
  const maxNodes = opts.maxNodes ?? 12000;
  let nodes = 0;
  const results: Move[] = [];
  const seen = new Set<string>();
  if (maxLay === 0) return results;

  const occupied = new Set(board.cells.keys());
  const blockedBase = new Set([...occupied, ...board.enclosed]);

  const record = (placed: PlacedTile[]) => {
    const mk = moveKey(placed);
    if (seen.has(mk)) return;
    seen.add(mk);
    results.push({ tiles: placed.map((t) => ({ tileId: t.tileId, cells: t.cells.slice() })) });
  };

  const done = () => results.length >= limit || nodes >= maxNodes;

  // `placed` is always a VALID partial move; we only ever extend with tiles that
  // keep it valid, so invalid colour branches are pruned instead of explored.
  const extend = (placed: PlacedTile[], used: Set<number>, groupCells: Set<string>) => {
    if (done() || placed.length >= maxLay) return;

    const blocked = new Set(blockedBase);
    for (const k of groupCells) blocked.add(k);

    const anchors =
      board.size === 0 && placed.length === 0
        ? new Set<string>(["0,0"])
        : frontier(groupCells.size ? groupCells : occupied, blocked);
    const anchorList = [...anchors];

    for (let idx = 0; idx < hand.length; idx++) {
      if (used.has(idx)) continue;
      if (done()) return;
      const tile = hand[idx];
      const cands =
        board.size === 0 && placed.length === 0
          ? originPlacements(tile)
          : anchorList.flatMap((a) => placementsCovering(tile, a, blocked));
      for (const p of cands) {
        if (done()) return;
        nodes++;
        const next = [...placed, p];
        if (!validateMove(board, next).ok) continue; // prune: never recurse on invalid
        record(next);
        const nextGroup = new Set(groupCells);
        for (const c of p.cells) nextGroup.add(key(c.x, c.y));
        used.add(idx);
        extend(next, used, nextGroup);
        used.delete(idx);
      }
    }
  };

  extend([], new Set(), new Set());
  return results;
}

/** Apply a move's tiles to a board (mutates). */
export function applyMoveToBoard(board: Board, move: Move): void {
  for (const t of move.tiles) for (const c of t.cells) board.place(c, t.tileId);
}
