import { Board } from "./board";
import { buildBag } from "./bag";
import {
  HAND_SIZE,
  LIVESTOCK,
  PLAYER_KITS,
  livestockPerk,
  livestockPerkFires,
  type LivestockPerk,
} from "./constants";
import { applyMoveToBoard, generateMoves } from "./moves";
import { validateMove } from "./placement";
import { findEnclosed, pastureBonus } from "./scoring";
import { makeRng, shuffle } from "./rng";
import type { Cell, Difficulty, Move, Player, Tile } from "./types";

export interface GameSnapshot {
  config: GameConfig;
  cells: [string, Cell][];
  enclosed: string[];
  acreOwner: [string, number][];
  bag: Tile[];
  players: Player[];
  current: number;
  turn: number;
  gameOver: boolean;
  winnerId: number | null;
  passes: number;
}

export interface PlayerConfig {
  name: string;
  isBot: boolean;
  difficulty?: Difficulty;
  colour?: string;
  animal?: string;
  farmerId?: string;
  farmerName?: string;
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
  fields?: number; // distinct fields sealed this move
  streak?: number; // actor's scoring streak after this move
  bonus?: number; // flair points awarded this move (streak + mega + livestock perk)
  mega?: boolean; // exceptional single move (≥3 acres or ≥2 fields)
  perk?: string; // livestock perk name, set when the perk's +1 fired this move
  herd?: number; // herd (pasture) bonus GAINED this move
  ended?: boolean;
}

/** Winning/ranking total: rules-pure acres + streak/mega flair + herd bonus. */
export const totalScore = (p: Player): number => p.score + (p.bonus ?? 0) + (p.herdBonus ?? 0);

const LIVESTOCK_PERK_NAME = Object.fromEntries(LIVESTOCK.map((l) => [l.perk, l.perkName])) as Record<
  LivestockPerk,
  string
>;

/** Sizes of the distinct 4-connected regions among a set of cell keys. */
function regionSizes(cellKeys: string[]): number[] {
  const set = new Set(cellKeys);
  const seen = new Set<string>();
  const sizes: number[] = [];
  for (const start of cellKeys) {
    if (seen.has(start)) continue;
    let size = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      size++;
      const [x, y] = stack.pop()!.split(",").map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = `${x + dx},${y + dy}`;
        if (set.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push(nk);
        }
      }
    }
    sizes.push(size);
  }
  return sizes;
}

export class Game {
  board = new Board();
  bag: Tile[] = [];
  players: Player[] = [];
  current = 0;
  turn = 0;
  gameOver = false;
  winnerId: number | null = null;
  private consecutiveSkips = 0;
  private rng: () => number;

  constructor(private config: GameConfig, restore?: GameSnapshot) {
    this.rng = makeRng(config.seed ?? 0x1234abcd);
    if (restore) this.load(restore);
    else this.deal();
  }

  /** Recompute every farmer's herd (pasture) bonus from current ownership.
   *  Each farmer's owned acres are grouped into connected fields and scored
   *  with pastureBonus. Called after any change to acreOwner. */
  private recomputeHerdBonus(): void {
    const byPlayer = new Map<number, Set<string>>();
    for (const [k, id] of this.board.acreOwner) {
      let s = byPlayer.get(id);
      if (!s) byPlayer.set(id, (s = new Set()));
      s.add(k);
    }
    for (const p of this.players) p.herdBonus = pastureBonus(byPlayer.get(p.id) ?? []);
  }

  private load(s: GameSnapshot): void {
    this.board.cells = new Map(s.cells.map(([k, c]) => [k, { ...c }]));
    this.board.enclosed = new Set(s.enclosed);
    this.board.acreOwner = new Map(s.acreOwner ?? []);
    this.bag = s.bag.map((t) => ({ id: t.id, segments: [...t.segments] }));
    // backfill colour/animal for saves written before livestock kits existed
    // (the save key is unchanged, so old in-progress games still rehydrate here)
    this.players = s.players.map((p, i) => ({
      ...p,
      hand: p.hand.map((t) => ({ id: t.id, segments: [...t.segments] })),
      bonus: p.bonus ?? 0, // backfill saves written before streak flair existed
      herdBonus: p.herdBonus ?? 0, // recomputed below from surviving ownership
      streak: p.streak ?? 0,
      colour: p.colour ?? PLAYER_KITS[i % PLAYER_KITS.length].colour,
      animal: p.animal ?? PLAYER_KITS[i % PLAYER_KITS.length].animal,
      farmerId: p.farmerId ?? PLAYER_KITS[i % PLAYER_KITS.length].farmerId,
      farmerName: p.farmerName ?? PLAYER_KITS[i % PLAYER_KITS.length].farmerName,
    }));
    this.current = s.current;
    this.turn = s.turn;
    this.gameOver = s.gameOver;
    this.winnerId = s.winnerId;
    this.consecutiveSkips = s.passes ?? 0;
    // self-heal a stale save: recompute enclosure under current rules and drop
    // any ownership for cells that are no longer truly enclosed
    this.board.enclosed = findEnclosed(this.board);
    for (const k of [...this.board.acreOwner.keys()])
      if (!this.board.enclosed.has(k)) this.board.acreOwner.delete(k);
    // reconcile scores with surviving ownership: a rules change (e.g. 4->8 conn)
    // can un-seal a field, so derive each score from the acres still owned
    const owned = new Map<number, number>();
    for (const id of this.board.acreOwner.values()) owned.set(id, (owned.get(id) ?? 0) + 1);
    for (const p of this.players) p.score = owned.get(p.id) ?? 0;
    this.recomputeHerdBonus(); // derive herd bonus from the surviving ownership
  }

  /** Deep, serializable snapshot of the whole game (for save/resume) — never aliases live state. */
  toSnapshot(): GameSnapshot {
    const tile = (t: Tile): Tile => ({ id: t.id, segments: [...t.segments] });
    return {
      config: { players: this.config.players.map((p) => ({ ...p })), seed: this.config.seed },
      cells: [...this.board.cells.entries()].map(([k, c]) => [k, { ...c }]),
      enclosed: [...this.board.enclosed],
      acreOwner: [...this.board.acreOwner],
      bag: this.bag.map(tile),
      players: this.players.map((p) => ({ ...p, hand: p.hand.map(tile) })),
      current: this.current,
      turn: this.turn,
      gameOver: this.gameOver,
      winnerId: this.winnerId,
      passes: this.consecutiveSkips,
    };
  }

  private deal(): void {
    this.bag = shuffle(buildBag(this.config.players.length), this.rng);
    this.players = this.config.players.map((p, id) => ({
      id,
      name: p.name,
      isBot: p.isBot,
      difficulty: p.difficulty ?? "medium",
      hand: this.bag.splice(0, HAND_SIZE),
      score: 0,
      bonus: 0,
      herdBonus: 0,
      streak: 0,
      colour: p.colour ?? PLAYER_KITS[id % PLAYER_KITS.length].colour,
      animal: p.animal ?? PLAYER_KITS[id % PLAYER_KITS.length].animal,
      farmerId: p.farmerId ?? PLAYER_KITS[id % PLAYER_KITS.length].farmerId,
      farmerName: p.farmerName ?? PLAYER_KITS[id % PLAYER_KITS.length].farmerName,
    }));
  }

  get currentPlayer(): Player {
    return this.players[this.current];
  }

  legalMoves(limit?: number): Move[] {
    return generateMoves(this.board, this.currentPlayer.hand, { limit, maxNodes: Infinity });
  }

  // exhaustive (no node cap) so the effort cap can never cause a false "must pass"
  hasLegalMove(): boolean {
    return generateMoves(this.board, this.currentPlayer.hand, { limit: 1, maxNodes: Infinity }).length > 0;
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

    // score newly enclosed acres + claim them for this farmer (animal/colour)
    const enclosedNow = findEnclosed(this.board);
    const newly: string[] = [];
    for (const k of enclosedNow)
      if (!this.board.enclosed.has(k)) {
        newly.push(k);
        this.board.acreOwner.set(k, player.id);
      }
    this.board.enclosed = enclosedNow;
    // keep ownership consistent with the truly-enclosed set (heals any stale claims)
    for (const k of [...this.board.acreOwner.keys()])
      if (!enclosedNow.has(k)) this.board.acreOwner.delete(k);
    player.score += newly.length;

    // streak/mega flair (cosmetic + small bonus on top of acres)
    const scored = newly.length;
    const sizes = scored > 0 ? regionSizes(newly) : [];
    const fields = sizes.length;
    const biggest = sizes.length ? Math.max(...sizes) : 0;
    const mega = scored >= 3 || fields >= 2;
    player.streak = scored > 0 ? player.streak + 1 : 0;
    const streakBonus = player.streak >= 2 ? Math.min(player.streak - 1, 3) : 0;

    // livestock perk: a small +1 that rewards the playstyle each animal favours.
    let perkBonus = 0;
    let perkName: string | undefined;
    if (scored > 0) {
      const kind = livestockPerk(player.animal);
      if (kind && livestockPerkFires(kind, { scored, fields, biggest, streak: player.streak })) {
        perkBonus = 1;
        perkName = LIVESTOCK_PERK_NAME[kind];
      }
    }

    const bonus = scored > 0 ? streakBonus + (mega ? 1 : 0) + perkBonus : 0;
    player.bonus += bonus;

    // herd ("animals accommodated") bonus: recompute every farmer's pasture
    // bonus from current ownership, and note how much THIS move gained.
    const herdBefore = player.herdBonus;
    this.recomputeHerdBonus();
    const herdGain = player.herdBonus - herdBefore;

    this.consecutiveSkips = 0;
    const flair = { scored, newlyEnclosed: newly, fields, streak: player.streak, bonus, mega, perk: perkName, herd: herdGain };

    // replenish
    while (player.hand.length < HAND_SIZE && this.bag.length > 0) player.hand.push(this.bag.pop()!);

    // end: a farmer has laid their last hedge (empty hand AND empty bag)
    if (player.hand.length === 0 && this.bag.length === 0) {
      this.endGame();
      return { ok: true, ...flair, ended: true };
    }

    this.advance();
    return { ok: true, ...flair };
  }

  /**
   * Safety backstop for the (empirically unreachable) case where the current
   * player has no legal placement. There is no player-facing "pass" — this only
   * keeps the engine sound: silently hand the turn on, and if a whole round goes
   * by with nobody able to move, end the game so play can never hang. In 300
   * self-play games (5,220 turns) this never fired; it exists purely so a
   * pathological monochrome hand can't freeze the turn loop.
   */
  skipStuck(): TurnResult {
    if (this.gameOver) return { ok: false, reason: "game over" };
    this.currentPlayer.streak = 0;
    this.consecutiveSkips++;
    if (this.consecutiveSkips >= this.players.length) {
      this.endGame();
      return { ok: true, ended: true };
    }
    this.advance();
    return { ok: true };
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
      if (totalScore(p) > bestScore) {
        bestScore = totalScore(p);
        best = p.id;
      }
    }
    this.winnerId = best;
  }

  /** Players sorted by total (acres + flair) desc (final standings). */
  standings(): Player[] {
    return [...this.players].sort((a, b) => totalScore(b) - totalScore(a));
  }
}
