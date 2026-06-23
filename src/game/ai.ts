import { Board, DIRS } from "./board";
import { buildBag } from "./bag";
import { HAND_SIZE } from "./constants";
import type { Game } from "./game";
import { applyMoveToBoard, generateMoves } from "./moves";
import { findEnclosed } from "./scoring";
import type { Difficulty, Move, Tile } from "./types";
import { key } from "./types";

type Rng = () => number;

const BREADTH: Record<Difficulty, number> = { easy: 24, medium: 48, hard: 80, expert: 80 };
const THREAT_TOP_K: Record<Difficulty, number> = { easy: 0, medium: 6, hard: 12, expert: 16 };

/** Apply a move to a board clone and return its acres-gained. Mutates the clone's enclosed. */
function applyAndScore(board: Board, move: Move): number {
  applyMoveToBoard(board, move);
  const now = findEnclosed(board);
  let gain = 0;
  for (const k of now) if (!board.enclosed.has(k)) gain++;
  board.enclosed = now;
  return gain;
}

/**
 * Cheap opponent-threat proxy: count "near-closed" cells (empty cells with 3
 * hedge neighbours OR enclosed-by-3 plus one near-empty). Avoids per-frontier
 * flood-fills.
 */
function nearClosedCount(board: Board): number {
  if (board.size === 0) return 0;
  const seen = new Set<string>();
  let count = 0;
  for (const k of board.cells.keys()) {
    const [x, y] = k.split(",").map(Number);
    for (const [dx, dy] of DIRS) {
      const ex = x + dx;
      const ey = y + dy;
      const ek = key(ex, ey);
      if (board.cells.has(ek) || board.enclosed.has(ek) || seen.has(ek)) continue;
      seen.add(ek);
      let walls = 0;
      for (const [ax, ay] of DIRS) if (board.cells.has(key(ex + ax, ey + ay))) walls++;
      if (walls >= 3) count++;
    }
  }
  return count;
}

/** Heuristic value of a candidate move from the mover's perspective. */
function heuristic(board: Board, move: Move, diff: Difficulty): { v: number; gain: number; after: Board } {
  const after = board.clone();
  const gain = applyAndScore(after, move);
  if (diff === "easy") return { v: gain, gain, after };
  // proxy threat: more near-closed cells = more steals available to next mover
  const threat = nearClosedCount(after);
  if (diff === "medium") return { v: gain - 0.4 * threat, gain, after };
  return { v: gain - 0.7 * threat + 0.05 * move.tiles.length, gain, after };
}

function pickGreedy(board: Board, hand: Tile[], diff: Difficulty, rng: Rng): Move | null {
  const moves = generateMoves(board, hand, { limit: BREADTH[diff] });
  if (moves.length === 0) return null;
  if (diff === "easy" && rng() < 0.5) return moves[Math.floor(rng() * moves.length)];
  let best = moves[0];
  let bestV = -Infinity;
  const topK = THREAT_TOP_K[diff];
  // for medium/hard, rank by immediate gain first, then re-score top-K with threat term
  if (topK > 0 && moves.length > topK) {
    const scored = moves.map((m) => {
      const after = board.clone();
      const gain = applyAndScore(after, m);
      return { m, gain };
    });
    scored.sort((a, b) => b.gain - a.gain);
    const head = scored.slice(0, topK);
    for (const s of head) {
      const v = heuristic(board, s.m, diff).v + rng() * 1e-3;
      if (v > bestV) {
        bestV = v;
        best = s.m;
      }
    }
    return best;
  }
  for (const m of moves) {
    const v = heuristic(board, m, diff).v + rng() * 1e-3;
    if (v > bestV) {
      bestV = v;
      best = m;
    }
  }
  return best;
}

// ---- Expert: determinized Monte Carlo with root UCT (ISMCTS-style) ----

interface SimState {
  board: Board;
  hands: Tile[][];
  bag: Tile[];
  scores: number[];
  current: number;
  passes: number;
  over: boolean;
}

function shuffleInPlace<T>(a: T[], rng: Rng): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

/** Sample a full hidden state consistent with what the AI can see. */
function determinize(game: Game, me: number, rng: Rng): SimState {
  const onBoard = new Set<number>();
  for (const c of game.board.cells.values()) onBoard.add(c.tileId);
  const myHandIds = new Set(game.players[me].hand.map((t) => t.id));
  const unseen = buildBag().filter((t) => !onBoard.has(t.id) && !myHandIds.has(t.id));
  shuffleInPlace(unseen, rng);

  const hands: Tile[][] = game.players.map((p, i) =>
    i === me ? p.hand.map((t) => ({ ...t })) : [],
  );
  for (let i = 0; i < game.players.length; i++) {
    if (i === me) continue;
    const n = game.players[i].hand.length;
    for (let k = 0; k < n; k++) {
      const t = unseen.pop();
      if (t) hands[i].push(t);
    }
  }
  return {
    board: game.board.clone(),
    hands,
    bag: unseen, // remainder is the bag
    scores: game.players.map((p) => p.score),
    current: game.current,
    passes: 0,
    over: false,
  };
}

/** Cheap rollout policy: random-ish legal move. */
function pickRandom(board: Board, hand: Tile[], rng: Rng): Move | null {
  const moves = generateMoves(board, hand, { limit: 12 });
  if (moves.length === 0) return null;
  // 50% chance: pick the move with highest immediate gain (cheap)
  if (rng() < 0.5) {
    let best = moves[0];
    let bestGain = -1;
    for (const m of moves) {
      const after = board.clone();
      const g = applyAndScore(after, m);
      if (g > bestGain) {
        bestGain = g;
        best = m;
      }
    }
    if (bestGain > 0) return best;
  }
  return moves[Math.floor(rng() * moves.length)];
}

function simStep(s: SimState, rng: Rng): void {
  const hand = s.hands[s.current];
  const move = pickRandom(s.board, hand, rng);
  if (!move) {
    s.passes++;
    if (s.passes >= s.hands.length) s.over = true;
    else s.current = (s.current + 1) % s.hands.length;
    return;
  }
  s.passes = 0;
  const gain = applyAndScore(s.board, move);
  s.scores[s.current] += gain;
  const used = new Set(move.tiles.map((t) => t.tileId));
  s.hands[s.current] = hand.filter((t) => !used.has(t.id));
  while (s.hands[s.current].length < HAND_SIZE && s.bag.length > 0)
    s.hands[s.current].push(s.bag.pop()!);
  if (s.hands[s.current].length === 0 && s.bag.length === 0) {
    s.over = true;
    return;
  }
  s.current = (s.current + 1) % s.hands.length;
}

function rollout(s: SimState, me: number, rng: Rng, maxPlies: number): number {
  let plies = 0;
  while (!s.over && plies < maxPlies) {
    simStep(s, rng);
    plies++;
  }
  let oppBest = -Infinity;
  for (let i = 0; i < s.scores.length; i++) if (i !== me) oppBest = Math.max(oppBest, s.scores[i]);
  return s.scores[me] - oppBest; // margin
}

function expertMove(game: Game, me: number, rng: Rng, iterations: number): Move | null {
  const root = generateMoves(game.board, game.players[me].hand, { limit: BREADTH.expert });
  if (root.length === 0) return null;
  if (root.length === 1) return root[0];

  const n = root.length;
  const visits = new Array(n).fill(0);
  const total = new Array(n).fill(0);
  const C = 1.3;

  for (let it = 0; it < iterations; it++) {
    let arm = 0;
    let bestU = -Infinity;
    for (let i = 0; i < n; i++) {
      if (visits[i] === 0) {
        arm = i;
        break;
      }
      const mean = total[i] / visits[i];
      const u = mean + C * Math.sqrt(Math.log(it + 1) / visits[i]);
      if (u > bestU) {
        bestU = u;
        arm = i;
      }
    }
    const s = determinize(game, me, rng);
    const gain = applyAndScore(s.board, root[arm]);
    s.scores[me] += gain;
    const used = new Set(root[arm].tiles.map((t) => t.tileId));
    s.hands[me] = s.hands[me].filter((t) => !used.has(t.id));
    while (s.hands[me].length < HAND_SIZE && s.bag.length > 0) s.hands[me].push(s.bag.pop()!);
    if (s.hands[me].length === 0 && s.bag.length === 0) {
      s.over = true;
    } else {
      s.current = (me + 1) % s.hands.length;
    }
    const margin = rollout(s, me, rng, 24);
    visits[arm]++;
    total[arm] += margin;
  }

  let best = 0;
  let bestV = -Infinity;
  for (let i = 0; i < n; i++) {
    if (visits[i] > bestV) {
      bestV = visits[i];
      best = i;
    }
  }
  return root[best];
}

export interface AiOptions {
  rng?: Rng;
  iterations?: number;
}

/** Choose a move for the current player, or null to pass. */
export function chooseAiMove(game: Game, opts: AiOptions = {}): Move | null {
  const rng = opts.rng ?? Math.random;
  const player = game.currentPlayer;
  if (player.difficulty === "expert") {
    // first move on an empty board: the search tree is huge and rollouts are
    // mostly noise — fall back to the strong heuristic.
    if (game.board.size === 0) return pickGreedy(game.board, player.hand, "hard", rng);
    return expertMove(game, game.current, rng, opts.iterations ?? 80);
  }
  return pickGreedy(game.board, player.hand, player.difficulty, rng);
}
