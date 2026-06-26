import { describe, expect, it } from "vitest";
import { Game } from "../../src/game/game";
import { redactFor, isPlaceholder } from "../../src/game/redact";

/** Two-human config; seed makes the bag/hands deterministic. */
const cfg = {
  seed: 0xc0ffee,
  players: [
    { name: "P0", isBot: false },
    { name: "P1", isBot: false },
  ],
};

describe("redactFor — the online security boundary", () => {
  it("strips the seed (bag order is reconstructable from it)", () => {
    const snap = new Game(cfg).toSnapshot();
    expect(snap.config.seed).toBeDefined();
    for (const seat of [0, 1]) {
      expect(redactFor(snap, seat).config.seed).toBeUndefined();
    }
  });

  it("replaces the whole bag with placeholders but preserves its count", () => {
    const snap = new Game(cfg).toSnapshot();
    const r = redactFor(snap, 0);
    expect(r.bag.length).toBe(snap.bag.length);
    expect(r.bag.every(isPlaceholder)).toBe(true);
    // no real tile identity survives
    expect(r.bag.some((t) => t.id >= 0)).toBe(false);
  });

  it("shows the seat its own real hand, others only as counts", () => {
    const snap = new Game(cfg).toSnapshot();
    for (const seat of [0, 1]) {
      const r = redactFor(snap, seat);
      // own hand: real, deep-equal
      expect(r.players[seat].hand).toEqual(snap.players[seat].hand);
      expect(r.players[seat].hand.some(isPlaceholder)).toBe(false);
      // every other hand: placeholders, correct length, no real ids
      for (let i = 0; i < r.players.length; i++) {
        if (i === seat) continue;
        expect(r.players[i].hand.length).toBe(snap.players[i].hand.length);
        expect(r.players[i].hand.every(isPlaceholder)).toBe(true);
      }
    }
  });

  it("leaks NOTHING about concealed tiles: redaction depends only on counts", () => {
    // Two games with identical player counts but different seeds → different
    // hidden bag/hands. From seat 0's view, everything hidden must be byte-identical
    // (only counts differ, and counts are equal here). If any concealed tile leaked,
    // these would differ.
    const a = redactFor(new Game({ ...cfg, seed: 1 }).toSnapshot(), 0);
    const b = redactFor(new Game({ ...cfg, seed: 999 }).toSnapshot(), 0);
    // own seat hands differ (real), so compare only the concealed surface:
    expect(a.bag).toEqual(b.bag);
    expect(a.players[1].hand).toEqual(b.players[1].hand);
    expect(a.config.seed).toEqual(b.config.seed); // both undefined
  });

  it("a redacted snapshot rehydrates cleanly into a Game (client mirror)", () => {
    const server = new Game(cfg);
    // play a few moves so the board is non-trivial
    for (let i = 0; i < 3 && !server.gameOver; i++) {
      const m = server.legalMoves(1)[0];
      if (!m) break;
      server.commit(m);
    }
    const r = redactFor(server.toSnapshot(), 0);
    const mirror = new Game({ players: cfg.players }); // no seed needed client-side
    expect(() => mirror.applySnapshot(r)).not.toThrow();
    // board + turn pointer + scores mirror the authority exactly
    expect(mirror.board.cells.size).toBe(server.board.cells.size);
    expect(mirror.current).toBe(server.current);
    expect(mirror.players.map((p) => p.score)).toEqual(server.players.map((p) => p.score));
    // bag count preserved; own hand real
    expect(mirror.bag.length).toBe(server.bag.length);
    expect(mirror.players[0].hand).toEqual(server.players[0].hand);
  });

  it("never exposes the opponent's hand contents even after replenish", () => {
    const server = new Game(cfg);
    const m = server.legalMoves(1)[0]!;
    server.commit(m); // triggers replenish from the (hidden) bag
    const r = redactFor(server.toSnapshot(), 0);
    expect(r.players[1].hand.every(isPlaceholder)).toBe(true);
  });

  it("redacts correctly for a 4-seat table (2 humans + 2 bots)", () => {
    // online 4-player: each seat must see only its OWN hand, never the bag or the
    // three other hands — regardless of which seats are bots.
    const cfg4 = {
      seed: 0xbadbeef,
      players: [
        { name: "Human0", isBot: false },
        { name: "Human1", isBot: false },
        { name: "Bot2", isBot: true },
        { name: "Bot3", isBot: true },
      ],
    };
    const snap = new Game(cfg4).toSnapshot();
    expect(snap.players.length).toBe(4);
    for (const seat of [0, 1, 2, 3]) {
      const r = redactFor(snap, seat);
      expect(r.config.seed).toBeUndefined();
      expect(r.bag.every(isPlaceholder)).toBe(true);
      expect(r.players[seat].hand).toEqual(snap.players[seat].hand);
      expect(r.players[seat].hand.some(isPlaceholder)).toBe(false);
      for (let i = 0; i < 4; i++) {
        if (i === seat) continue;
        expect(r.players[i].hand.length).toBe(snap.players[i].hand.length);
        expect(r.players[i].hand.every(isPlaceholder)).toBe(true);
      }
      // isBot flags stay visible — the client needs them to drive turn UI
      expect(r.players.map((p) => p.isBot)).toEqual([false, false, true, true]);
    }
  });
});
