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
 * Rules (Qwirkle-strict on colour):
 *  - every cell empty, not inside an enclosed field, no self-overlap
 *  - every orthogonally abutting segment-pair (to existing tiles OR between this
 *    turn's distinct tiles) must be the SAME colour
 *  - all hedges laid this turn must JOIN UP into one connected run: each laid
 *    hedge has to abut at least one other hedge laid in the same turn. (Subtle
 *    rule — easy to miss — so the rejection spells it out.)
 *  - unless it's the very first move, that run must also touch >=1 existing hedge
 *    (no hedges floating free of the established hedgerow network)
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

  // Every hedge laid this turn must connect to another hedge laid this turn, so
  // the whole turn forms ONE connected run. (With MAX_LAY=3, "each laid hedge
  // touches another laid hedge" is equivalent to the laid cells forming a single
  // orthogonal component — an isolated tile would be its own component.)
  const comps = components(moveCells);
  if (comps.length > 1)
    return { ok: false, reason: "every hedge you lay in a turn must connect to another hedge from the same turn" };

  // After the opening move, that one run must also anchor to the existing
  // network — no hedges floating free of the established hedgerow.
  if (board.size > 0 && !touchesExisting(comps[0], board))
    return { ok: false, reason: "not linked to an existing hedge" };

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
