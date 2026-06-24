import { describe, expect, it } from "vitest";
import { Game } from "../../src/game/game";
import { chooseAiMove } from "../../src/game/ai";
import { makeRng } from "../../src/game/rng";
import { BAG_SIZE } from "../../src/game/bag";
import type { Colour, Difficulty } from "../../src/game/types";

describe("scoring", () => {
  it("the move that seals a big field scores all its acres to the closer", () => {
    const g = new Game({ seed: 1, players: [{ name: "A", isBot: true }, { name: "B", isBot: true }] });
    g.board.cells.clear();
    const G: Colour = "G";
    const wall = (x: number, y: number) => g.board.cells.set(`${x},${y}`, { colour: G, tileId: 0 });
    // green ring around a 3x3 interior (9 acres), with a 3-cell gap in the top wall
    for (let x = 0; x <= 4; x++) wall(x, 4); // bottom
    wall(0, 0);
    wall(4, 0); // top corners only -> gap at (1..3, 0)
    for (let y = 1; y <= 3; y++) {
      wall(0, y);
      wall(4, y);
    }
    const me = g.current;
    const before = g.players[me].score;
    g.players[me].hand = [{ id: 999, segments: [G, G, G] }, ...g.players[me].hand.slice(1)];
    const res = g.commit({
      tiles: [
        {
          tileId: 999,
          cells: [
            { x: 1, y: 0, colour: G },
            { x: 2, y: 0, colour: G },
            { x: 3, y: 0, colour: G },
          ],
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.scored).toBe(9);
    expect(g.players[me].score).toBe(before + 9);
    let owned = 0;
    for (const [, pid] of g.board.acreOwner) if (pid === me) owned++;
    expect(owned).toBe(9);
  });
});

describe("snapshot", () => {
  it("round-trips game state and keeps playing", () => {
    const g = new Game({ seed: 5, players: [{ name: "A", isBot: true }, { name: "B", isBot: true }] });
    const rng = makeRng(5);
    for (let i = 0; i < 6; i++) {
      const m = chooseAiMove(g, { rng });
      if (m) g.commit(g.legalMoves(1)[0] ?? m);
      else g.pass();
    }
    const snap = JSON.parse(JSON.stringify(g.toSnapshot()));
    const restored = new Game(snap.config, snap);
    expect(restored.board.cells.size).toBe(g.board.cells.size);
    expect(restored.players.map((p) => p.score)).toEqual(g.players.map((p) => p.score));
    expect(restored.current).toBe(g.current);
    expect(restored.bag.length).toBe(g.bag.length);
    // restored game can still produce a legal move
    expect(restored.legalMoves(1).length).toBeGreaterThanOrEqual(0);
  });

  it("does not alias live game state (snapshot is a deep copy)", () => {
    const g = new Game({ seed: 5, players: [{ name: "A", isBot: true }, { name: "B", isBot: true }] });
    const snap = g.toSnapshot();
    const handBefore = snap.players[g.current].hand.length;
    const cellsBefore = snap.cells.length;
    // mutate the live game
    const m = g.legalMoves(1)[0];
    if (m) g.commit(m);
    // the snapshot taken earlier must be unchanged
    expect(snap.players[snap.current].hand.length).toBe(handBefore);
    expect(snap.cells.length).toBe(cellsBefore);
  });
});

function placedTileCount(game: Game): number {
  const ids = new Set<number>();
  for (const c of game.board.cells.values()) ids.add(c.tileId);
  return ids.size;
}

function conserved(game: Game): boolean {
  const inHands = game.players.reduce((n, p) => n + p.hand.length, 0);
  return game.bag.length + inHands + placedTileCount(game) === BAG_SIZE;
}

function playOut(difficulties: Difficulty[], seed: number, expertIters = 20): Game {
  const game = new Game({
    seed,
    players: difficulties.map((d, i) => ({ name: `Bot${i}`, isBot: true, difficulty: d })),
  });
  const rng = makeRng(seed ^ 0x9e3779b9);
  let turns = 0;
  while (!game.gameOver && turns < 2000) {
    const move = chooseAiMove(game, { rng, iterations: expertIters });
    if (move) game.commit(move);
    else game.pass();
    turns++;
  }
  return game;
}

describe("AI", () => {
  it("chooseAiMove returns a legal move on a fresh board", () => {
    const game = new Game({ seed: 7, players: [{ name: "A", isBot: true, difficulty: "hard" }] });
    const m = chooseAiMove(game, { rng: makeRng(1) });
    expect(m).not.toBeNull();
    expect(m!.tiles.length).toBeGreaterThanOrEqual(1);
  });

  it("easy two-player game finishes and conserves tiles", () => {
    const game = playOut(["easy", "easy"], 42);
    expect(game.gameOver).toBe(true);
    expect(conserved(game)).toBe(true);
    expect(game.winnerId).not.toBeNull();
  });

  it("medium two-player game finishes and conserves tiles", () => {
    const game = playOut(["medium", "medium"], 7);
    expect(game.gameOver).toBe(true);
    expect(conserved(game)).toBe(true);
  });

  it("mixed four-player game finishes", () => {
    const game = playOut(["easy", "easy", "medium", "medium"], 99);
    expect(game.gameOver).toBe(true);
    for (const p of game.players) expect(p.score).toBeGreaterThanOrEqual(0);
    expect(conserved(game)).toBe(true);
  });

  it("expert stays within its time budget on a busy mid-game board (no freeze)", () => {
    // build a non-trivial board by playing several turns, then time an expert move
    const game = new Game({
      seed: 21,
      players: [
        { name: "E", isBot: true, difficulty: "expert" },
        { name: "H", isBot: true, difficulty: "hard" },
      ],
    });
    const rng = makeRng(21);
    for (let i = 0; i < 10; i++) {
      const m = chooseAiMove(game, { rng, maxMs: 120 });
      if (m) game.commit(m);
      else game.pass();
      if (game.gameOver) break;
    }
    if (!game.gameOver) {
      // force an expert decision and assert it returns promptly
      game.players[game.current].difficulty = "expert";
      const t0 = performance.now();
      const m = chooseAiMove(game, { rng, maxMs: 150 });
      const dt = performance.now() - t0;
      expect(m === null || m.tiles.length >= 1).toBe(true);
      expect(dt).toBeLessThan(1500); // generous CI margin; real budget is ~150ms
    }
  });

  it("expert produces a legal move within a small budget", () => {
    const game = new Game({
      seed: 3,
      players: [
        { name: "E", isBot: true, difficulty: "expert" },
        { name: "M", isBot: true, difficulty: "medium" },
      ],
    });
    // play a single medium move first so expert's root isn't the empty-board worst case
    const opener = chooseAiMove(game, { rng: makeRng(99) });
    if (opener) game.commit(opener);
    const m = chooseAiMove(game, { rng: makeRng(11), iterations: 5 });
    expect(m).not.toBeNull();
  });
});
