import { Board } from "./board";
import { buildBag } from "./bag";
import { HAND_SIZE } from "./constants";
import { applyMoveToBoard, generateMoves } from "./moves";
import { validateMove } from "./placement";
import { findEnclosed } from "./scoring";
import { makeRng, shuffle } from "./rng";
import type { Difficulty, Move, Player, Tile } from "./types";

export interface PlayerConfig {
  name: string;
  isBot: boolean;
  difficulty?: Difficulty;
}

export interface GameConfig {
  players: PlayerConfig[];
  seed?: number;
}

export interface TurnResult {
  ok: boolean;
  reason?: string;
  scored?: number;
  newlyEnclosed?: string[];
  passed?: boolean;
  ended?: boolean;
}

export class Game {
  board = new Board();
  bag: Tile[] = [];
  players: Player[] = [];
  current = 0;
  turn = 0;
  gameOver = false;
  winnerId: number | null = null;
  private consecutivePasses = 0;
  private rng: () => number;

  constructor(private config: GameConfig) {
    this.rng = makeRng(config.seed ?? 0x1234abcd);
    this.deal();
  }

  private deal(): void {
    this.bag = shuffle(buildBag(), this.rng);
    this.players = this.config.players.map((p, id) => ({
      id,
      name: p.name,
      isBot: p.isBot,
      difficulty: p.difficulty ?? "medium",
      hand: this.bag.splice(0, HAND_SIZE),
      score: 0,
    }));
  }

  get currentPlayer(): Player {
    return this.players[this.current];
  }

  legalMoves(limit?: number): Move[] {
    return generateMoves(this.board, this.currentPlayer.hand, { limit });
  }

  hasLegalMove(): boolean {
    return generateMoves(this.board, this.currentPlayer.hand, { limit: 1 }).length > 0;
  }

  /** Commit a turn for the current player. */
  commit(move: Move): TurnResult {
    if (this.gameOver) return { ok: false, reason: "game over" };
    const v = validateMove(this.board, move.tiles);
    if (!v.ok) return { ok: false, reason: v.reason };

    const player = this.currentPlayer;
    // verify the tiles are actually in the player's hand
    const handIds = new Set(player.hand.map((t) => t.id));
    for (const t of move.tiles) if (!handIds.has(t.tileId)) return { ok: false, reason: "tile not in hand" };

    applyMoveToBoard(this.board, move);
    const usedIds = new Set(move.tiles.map((t) => t.tileId));
    player.hand = player.hand.filter((t) => !usedIds.has(t.id));

    // score newly enclosed acres
    const enclosedNow = findEnclosed(this.board);
    const newly: string[] = [];
    for (const k of enclosedNow) if (!this.board.enclosed.has(k)) newly.push(k);
    this.board.enclosed = enclosedNow;
    player.score += newly.length;

    this.consecutivePasses = 0;

    // replenish
    while (player.hand.length < HAND_SIZE && this.bag.length > 0) player.hand.push(this.bag.pop()!);

    // end: a farmer has laid their last hedge (empty hand AND empty bag)
    if (player.hand.length === 0 && this.bag.length === 0) {
      this.endGame();
      return { ok: true, scored: newly.length, newlyEnclosed: newly, ended: true };
    }

    this.advance();
    return { ok: true, scored: newly.length, newlyEnclosed: newly };
  }

  /** Current player has no legal move (or chooses to pass). */
  pass(): TurnResult {
    if (this.gameOver) return { ok: false, reason: "game over" };
    this.consecutivePasses++;
    if (this.consecutivePasses >= this.players.length) {
      this.endGame();
      return { ok: true, passed: true, ended: true };
    }
    this.advance();
    return { ok: true, passed: true };
  }

  private advance(): void {
    this.current = (this.current + 1) % this.players.length;
    this.turn++;
  }

  private endGame(): void {
    this.gameOver = true;
    let best = -1;
    let bestScore = -Infinity;
    for (const p of this.players) {
      if (p.score > bestScore) {
        bestScore = p.score;
        best = p.id;
      }
    }
    this.winnerId = best;
  }

  /** Players sorted by score desc (final standings). */
  standings(): Player[] {
    return [...this.players].sort((a, b) => b.score - a.score);
  }
}
