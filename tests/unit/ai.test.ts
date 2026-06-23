import { describe, expect, it } from "vitest";
import { Game } from "../../src/game/game";
import { chooseAiMove } from "../../src/game/ai";
import { makeRng } from "../../src/game/rng";
import { BAG_SIZE } from "../../src/game/bag";
import type { Difficulty } from "../../src/game/types";

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
