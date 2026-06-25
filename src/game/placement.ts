import { Board, DIRS } from "./board";
import { MAX_LAY } from "./constants";
import type { PlacedCell, PlacedTile } from "./types";
import { key } from "./types";

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a turn's placed tiles against the board.
 * Rules (Qwirkle-strict on colour, but laid hedges need NOT all join up):
 *  - every cell empty, not inside an enclosed field, no self-overlap
 *  - every orthogonally abutting segment-pair (to existing tiles OR between this
 *    turn's distinct tiles) must be the SAME colour
 *  - unless it's the very first move, EACH separate run of laid hedges must touch
 *    >=1 existing tile — so you can drop several unrelated hedges in one turn, but
 *    each must still attach to the existing hedgerow network (no floating hedges)
 */
export function validateMove(board: Board, tiles: PlacedTile[]): ValidationResult {
  if (tiles.length === 0) return { ok: false, reason: "empty move" };
  if (tiles.length > MAX_LAY) return { ok: false, reason: `lay at most ${MAX_LAY} hedges per turn` };

  // map cell -> tileId for this move, and detect overlaps / occupied / enclosed
  const moveCells = new Map<string, { colour: PlacedCell["colour"]; tileId: number }>();
  const tileIds = new Set<number>();
  for (const t of tiles) {
    if (tileIds.has(t.tileId)) return { ok: false, reason: "a hedge cannot be laid twice" };
    tileIds.add(t.tileId);
    if (t.cells.length !== 3) return { ok: false, reason: "tile must cover 3 cells" };
    for (const c of t.cells) {
      const k = key(c.x, c.y);
      if (board.cells.has(k)) return { ok: false, reason: "cell occupied" };
      if (board.enclosed.has(k)) return { ok: false, reason: "cannot lay inside an enclosed field" };
      if (moveCells.has(k)) return { ok: false, reason: "tiles overlap" };
      moveCells.set(k, { colour: c.colour, tileId: t.tileId });
    }
  }

  // colour-match every contact (existing board + cross-tile within the move)
  for (const [k, self] of moveCells) {
    const [x, y] = k.split(",").map(Number);
    for (const [dx, dy] of DIRS) {
      const nk = key(x + dx, y + dy);
      const existing = board.cells.get(nk);
      if (existing) {
        if (existing.colour !== self.colour)
          return { ok: false, reason: "colour mismatch with existing hedge" };
        continue;
      }
      const mv = moveCells.get(nk);
      if (mv && mv.tileId !== self.tileId && mv.colour !== self.colour)
        return { ok: false, reason: "colour mismatch between laid hedges" };
    }
  }

  // After the opening move, every separate run of laid hedges must anchor to the
  // existing network — unrelated hedges are fine, floating ones are not.
  if (board.size > 0) {
    for (const comp of components(moveCells)) {
      if (!touchesExisting(comp, board))
        return { ok: false, reason: "not linked to an existing hedge" };
    }
  }

  return { ok: true };
}

/** Orthogonally-connected components of the move's own cells. */
function components(moveCells: Map<string, unknown>): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const start of moveCells.keys()) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      const [x, y] = k.split(",").map(Number);
      for (const [dx, dy] of DIRS) {
        const nk = key(x + dx, y + dy);
        if (moveCells.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push(nk);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/** Does any cell of this run orthogonally abut an existing hedge? */
function touchesExisting(comp: string[], board: Board): boolean {
  for (const k of comp) {
    const [x, y] = k.split(",").map(Number);
    for (const [dx, dy] of DIRS) {
      if (board.cells.has(key(x + dx, y + dy))) return true;
    }
  }
  return false;
}
