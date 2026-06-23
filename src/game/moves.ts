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
}

/** Enumerate all legal turns (lay 1..maxLay colour-linked tiles). */
export function generateMoves(board: Board, hand: Tile[], opts: GenOptions = {}): Move[] {
  const maxLay = Math.min(opts.maxLay ?? 3, hand.length);
  const limit = opts.limit ?? Infinity;
  const results: Move[] = [];
  const seen = new Set<string>();
  if (maxLay === 0) return results;

  const occupied = new Set(board.cells.keys());
  const blockedBase = new Set([...occupied, ...board.enclosed]);

  const record = (placed: PlacedTile[]) => {
    const mk = moveKey(placed);
    if (seen.has(mk)) return;
    if (!validateMove(board, placed).ok) return;
    seen.add(mk);
    results.push({ tiles: placed.map((t) => ({ tileId: t.tileId, cells: t.cells.slice() })) });
  };

  const dfs = (placed: PlacedTile[], used: Set<number>, groupCells: Set<string>) => {
    if (results.length >= limit) return;
    if (placed.length >= 1) record(placed);
    if (placed.length >= maxLay || results.length >= limit) return;

    const blocked = new Set(blockedBase);
    for (const k of groupCells) blocked.add(k);

    // where can the next tile attach?
    const anchors =
      board.size === 0 && placed.length === 0
        ? new Set<string>(["0,0"])
        : frontier(groupCells.size ? groupCells : occupied, blocked);

    const anchorList = [...anchors];
    for (let idx = 0; idx < hand.length; idx++) {
      if (used.has(idx)) continue;
      if (results.length >= limit) return;
      const tile = hand[idx];
      if (board.size === 0 && placed.length === 0) {
        for (const p of originPlacements(tile)) {
          if (results.length >= limit) return;
          const nextGroup = new Set(groupCells);
          for (const c of p.cells) nextGroup.add(key(c.x, c.y));
          used.add(idx);
          dfs([...placed, p], used, nextGroup);
          used.delete(idx);
        }
        continue;
      }
      for (const a of anchorList) {
        if (results.length >= limit) return;
        for (const p of placementsCovering(tile, a, blocked)) {
          if (results.length >= limit) return;
          const nextGroup = new Set(groupCells);
          for (const c of p.cells) nextGroup.add(key(c.x, c.y));
          used.add(idx);
          dfs([...placed, p], used, nextGroup);
          used.delete(idx);
        }
      }
    }
  };

  dfs([], new Set(), new Set());
  return results;
}

/** Apply a move's tiles to a board (mutates). */
export function applyMoveToBoard(board: Board, move: Move): void {
  for (const t of move.tiles) for (const c of t.cells) board.place(c, t.tileId);
}
