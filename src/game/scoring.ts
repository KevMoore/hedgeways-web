import { Board, DIRS } from "./board";
import { key } from "./types";

/**
 * All empty cells that are enclosed: cannot reach the open exterior via
 * orthogonal moves through empty cells. (4-connectivity -> diagonal-only hedge
 * corners correctly do NOT seal a field.)
 */
export function findEnclosed(board: Board): Set<string> {
  const enclosed = new Set<string>();
  if (board.size === 0) return enclosed;

  const { minX, minY, maxX, maxY } = board.bounds();
  const loX = minX - 1,
    loY = minY - 1,
    hiX = maxX + 1,
    hiY = maxY + 1;

  // Flood the exterior: start from the margin ring, walk through empty cells.
  const outside = new Set<string>();
  const stack: [number, number][] = [];
  const pushIfOpen = (x: number, y: number) => {
    if (x < loX || x > hiX || y < loY || y > hiY) return;
    const k = key(x, y);
    if (outside.has(k) || board.cells.has(k)) return;
    outside.add(k);
    stack.push([x, y]);
  };
  // seed the entire border ring
  for (let x = loX; x <= hiX; x++) {
    pushIfOpen(x, loY);
    pushIfOpen(x, hiY);
  }
  for (let y = loY; y <= hiY; y++) {
    pushIfOpen(loX, y);
    pushIfOpen(hiX, y);
  }
  while (stack.length) {
    const [x, y] = stack.pop()!;
    for (const [dx, dy] of DIRS) pushIfOpen(x + dx, y + dy);
  }

  // any empty interior cell not reached by the exterior is enclosed
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const k = key(x, y);
      if (!board.cells.has(k) && !outside.has(k)) enclosed.add(k);
    }
  }
  return enclosed;
}

/** Group enclosed cells into connected fields (for FX / reporting). */
export function fields(enclosed: Set<string>): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const start of enclosed) {
    if (seen.has(start)) continue;
    const group: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop()!;
      group.push(k);
      const [x, y] = k.split(",").map(Number);
      for (const [dx, dy] of DIRS) {
        const nk = key(x + dx, y + dy);
        if (enclosed.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push(nk);
        }
      }
    }
    out.push(group);
  }
  return out;
}
