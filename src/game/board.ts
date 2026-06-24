import type { Cell, Colour, Orientation, PlacedCell, Tile } from "./types";
import { key } from "./types";

export class Board {
  cells = new Map<string, Cell>();
  /** Empty cells known to be inside an enclosed field (locked: no hedges allowed). */
  enclosed = new Set<string>();
  /** Enclosed cell -> id of the farmer who claimed it (for animal/colour fill). */
  acreOwner = new Map<string, number>();

  get(x: number, y: number): Cell | undefined {
    return this.cells.get(key(x, y));
  }
  has(x: number, y: number): boolean {
    return this.cells.has(key(x, y));
  }
  get size(): number {
    return this.cells.size;
  }

  place(pc: PlacedCell, tileId: number): void {
    this.cells.set(key(pc.x, pc.y), { colour: pc.colour, tileId });
  }

  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const k of this.cells.keys()) {
      const i = k.indexOf(",");
      const x = +k.slice(0, i);
      const y = +k.slice(i + 1);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  clone(): Board {
    const b = new Board();
    b.cells = new Map(this.cells);
    b.enclosed = new Set(this.enclosed);
    b.acreOwner = new Map(this.acreOwner);
    return b;
  }
}

export const DIRS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Resolve a tile's three segments onto the grid. */
export function orient(
  tile: Tile,
  x: number,
  y: number,
  dir: Orientation,
  flip: boolean,
): PlacedCell[] {
  const [dx, dy] = dir === "H" ? [1, 0] : [0, 1];
  const out: PlacedCell[] = [];
  for (let i = 0; i < 3; i++) {
    const colour: Colour = flip ? tile.segments[2 - i] : tile.segments[i];
    out.push({ x: x + dx * i, y: y + dy * i, colour });
  }
  return out;
}

/** Whether flipping this tile produces a distinct placement. */
export function isPalindrome(tile: Tile): boolean {
  return tile.segments[0] === tile.segments[2];
}
