import { describe, expect, it } from "vitest";
import { Board, orient } from "../../src/game/board";
import { validateMove } from "../../src/game/placement";
import { findEnclosed, fields } from "../../src/game/scoring";
import { generateMoves } from "../../src/game/moves";
import type { Colour, PlacedTile, Tile } from "../../src/game/types";
import { key } from "../../src/game/types";

const tile = (id: number, s: string): Tile => ({
  id,
  segments: s.split("") as [Colour, Colour, Colour],
});

function ring(board: Board, cells: [number, number][]) {
  for (const [x, y] of cells) board.cells.set(key(x, y), { colour: "G", tileId: 0 });
}

describe("enclosure", () => {
  it("encloses a single empty cell ringed by hedges", () => {
    const b = new Board();
    ring(b, [
      [0, 0], [1, 0], [2, 0],
      [0, 1], [2, 1],
      [0, 2], [1, 2], [2, 2],
    ]);
    const enc = findEnclosed(b);
    expect([...enc]).toEqual(["1,1"]);
    expect(fields(enc)).toHaveLength(1);
  });

  it("does not enclose when there is an orthogonal gap", () => {
    const b = new Board();
    ring(b, [
      [0, 0], [2, 0], // top middle (1,0) missing -> open
      [0, 1], [2, 1],
      [0, 2], [1, 2], [2, 2],
    ]);
    expect(findEnclosed(b).size).toBe(0);
  });

  it("scores a big enclosed field at its full acre count (e.g. 20)", () => {
    const b = new Board();
    const wall = (x: number, y: number) => b.cells.set(key(x, y), { colour: "G", tileId: 0 });
    // rectangle ring enclosing a 4-wide x 5-tall interior = 20 empty acres
    for (let x = 0; x <= 5; x++) {
      wall(x, 0);
      wall(x, 6);
    }
    for (let y = 1; y <= 5; y++) {
      wall(0, y);
      wall(5, y);
    }
    const enc = findEnclosed(b);
    expect(enc.size).toBe(20); // no cap on acres
    expect(fields(enc)).toHaveLength(1); // a single field
  });

  it("counts multiple acres in a larger field", () => {
    const b = new Board();
    const walls: [number, number][] = [];
    for (let x = 0; x <= 3; x++) {
      walls.push([x, 0], [x, 3]);
    }
    for (let y = 1; y <= 2; y++) {
      walls.push([0, y], [3, y]);
    }
    ring(b, walls);
    const enc = findEnclosed(b);
    expect(enc.size).toBe(4); // 2x2 interior
  });
});

describe("placement (Qwirkle-strict)", () => {
  it("allows the first move anywhere", () => {
    const b = new Board();
    const t = tile(1, "GYB");
    const move: PlacedTile[] = [{ tileId: 1, cells: orient(t, 0, 0, "H", false) }];
    expect(validateMove(b, move).ok).toBe(true);
  });

  it("requires a colour match with the existing hedge", () => {
    const b = new Board();
    const t1 = tile(1, "GYB");
    for (const c of orient(t1, 0, 0, "H", false)) b.place(c, 1);
    // place a vertical tile whose top touches the 'G' at (0,0) from below at (0,1)
    const good = tile(2, "GYB"); // (0,1)=G matches (0,0)=G above
    const goodMove: PlacedTile[] = [{ tileId: 2, cells: orient(good, 0, 1, "V", false) }];
    expect(validateMove(b, goodMove).ok).toBe(true);

    const bad = tile(3, "YGB"); // (0,1)=Y vs (0,0)=G -> mismatch
    const badMove: PlacedTile[] = [{ tileId: 3, cells: orient(bad, 0, 1, "V", false) }];
    expect(validateMove(b, badMove).ok).toBe(false);
  });

  it("rejects laying more than 3 hedges in a turn", () => {
    const b = new Board();
    // four colour-linked all-green tiles in a connected row of rows
    const tiles: PlacedTile[] = [
      { tileId: 1, cells: orient(tile(1, "GGG"), 0, 0, "H", false) },
      { tileId: 2, cells: orient(tile(2, "GGG"), 0, 1, "H", false) },
      { tileId: 3, cells: orient(tile(3, "GGG"), 0, 2, "H", false) },
      { tileId: 4, cells: orient(tile(4, "GGG"), 0, 3, "H", false) },
    ];
    expect(validateMove(b, tiles).ok).toBe(false);
    expect(validateMove(b, tiles.slice(0, 3)).ok).toBe(true);
  });

  it("rejects laying the same hedge twice in one turn", () => {
    const b = new Board();
    const t = tile(1, "GGG");
    const dup: PlacedTile[] = [
      { tileId: 1, cells: orient(t, 0, 0, "H", false) },
      { tileId: 1, cells: orient(t, 0, 1, "H", false) },
    ];
    expect(validateMove(b, dup).ok).toBe(false);
  });

  it("allows different colours where tiles only touch at a corner (diagonal)", () => {
    const b = new Board();
    b.cells.set(key(5, 0), { colour: "G", tileId: 1 }); // orthogonal link (must match)
    b.cells.set(key(6, 4), { colour: "Y", tileId: 2 }); // only corner-touches the new tile
    // new vertical tile G/P/P at (5,1),(5,2),(5,3): (5,1) edge-matches the G above,
    // (5,3)=P only diagonally touches the Y at (6,4) -> allowed
    const move: PlacedTile[] = [{ tileId: 3, cells: orient(tile(3, "GPP"), 5, 1, "V", false) }];
    expect(validateMove(b, move).ok).toBe(true);
    // but a colour mismatch on the orthogonal (edge) contact is still illegal
    const bad: PlacedTile[] = [{ tileId: 4, cells: orient(tile(4, "YPP"), 5, 1, "V", false) }];
    expect(validateMove(b, bad).ok).toBe(false);
  });

  it("does not enclose a cell whose corner is only diagonally closed (leaks out)", () => {
    const b = new Board();
    // (1,1) is ringed by 4 orthogonal walls, BUT the corner (0,0) is open and the
    // walls (1,0)/(0,1) touch only diagonally -> the field leaks through the corner
    ring(b, [
      [1, 0],
      [0, 1],
      [2, 1],
      [1, 2],
    ]);
    expect(findEnclosed(b).size).toBe(0);
  });

  it("does not enclose a field whose walls only meet at corners", () => {
    const b = new Board();
    // a diagonal 'staircase' of hedges around (1,1): they touch only at corners,
    // leaving orthogonal gaps, so the interior is not sealed
    for (const [x, y] of [
      [1, 0], [0, 1], // top + left meet (1,1) only via these two ortho cells...
      [2, 2], [1, 2], // ...but the bottom/right are offset so gaps remain
    ] as [number, number][])
      b.cells.set(key(x, y), { colour: "G", tileId: 0 });
    expect(findEnclosed(b).size).toBe(0);
  });

  it("rejects a tile not linked to anything", () => {
    const b = new Board();
    const t1 = tile(1, "GYB");
    for (const c of orient(t1, 0, 0, "H", false)) b.place(c, 1);
    const far = tile(2, "GYB");
    const m: PlacedTile[] = [{ tileId: 2, cells: orient(far, 10, 10, "H", false) }];
    expect(validateMove(b, m).ok).toBe(false);
  });
});

describe("move generation", () => {
  it("produces only valid moves", () => {
    const b = new Board();
    const t1 = tile(1, "GGG");
    for (const c of orient(t1, 0, 0, "H", false)) b.place(c, 1);
    const hand: Tile[] = [tile(2, "GYB"), tile(3, "GGG")];
    const moves = generateMoves(b, hand);
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect(validateMove(b, m.tiles).ok).toBe(true);
  });

  it("first move on an empty board generates placements", () => {
    const b = new Board();
    const moves = generateMoves(b, [tile(1, "GYB")]);
    expect(moves.length).toBeGreaterThan(0);
  });
});
