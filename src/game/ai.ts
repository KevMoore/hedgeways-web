import { Board, DIRS } from "./board";
import { buildBag } from "./bag";
import { HAND_SIZE } from "./constants";
import type { Game } from "./game";
import { applyMoveToBoard, generateMoves } from "./moves";
import { findEnclosed } from "./scoring";
import type { Difficulty, FarmerStyle, Move, Tile } from "./types";
import { key } from "./types";

type Rng = () => number;

const BREADTH: Record<Difficulty, number> = { easy: 24, medium: 48, hard: 80, expert: 80 };

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
/**
 * Per-empty-cell wall stats around the hedges:
 *  - pens:    empties with exactly 2 orthogonal walls (a field taking shape)
 *  - threats: empties with >=3 orthogonal walls (a near-done field a rival could grab)
 * Rewarding pens makes bots build toward enclosures; penalising threats stops
 * them gifting an almost-finished field to the next player (closer-takes-all).
 */
function pocketStats(board: Board): { pens: number; threats: number } {
  let pens = 0;
  let threats = 0;
  if (board.size === 0) return { pens, threats };
  const seen = new Set<string>();
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
      if (walls >= 3) threats++;
      else if (walls === 2) pens++;
    }
  }
  return { pens, threats };
}

/**
 * Move-scoring weights. Difficulty sets the baseline (raw strength); a farmer's
 * STYLE then re-weights the terms to give it a personality. Default (no style)
 * reproduces the original per-difficulty formula exactly.
 */
interface Weights {
  gain: number; // acres sealed this move
  threat: number; // penalty per near-done field left for a rival (closer-takes-all)
  pen: number; // reward per half-built pocket (building toward enclosures)
  tile: number; // reward per tile laid (aggression / tempo)
  jitter: number; // tie-break noise
}
const WEIGHTS_BASE: Record<Difficulty, Weights> = {
  easy: { gain: 1, threat: 0, pen: 0, tile: 0, jitter: 1e-3 },
  medium: { gain: 1, threat: 0.4, pen: 0.1, tile: 0, jitter: 1e-3 },
  hard: { gain: 1, threat: 0.6, pen: 0.15, tile: 0.05, jitter: 1e-3 },
  expert: { gain: 1, threat: 0.6, pen: 0.15, tile: 0.05, jitter: 1e-3 },
};

interface StyleCfg {
  threat?: number; // absolute coefficients (these are the levers that actually
  pen?: number; //    flip move choices — scaling `gain` is argmax-invariant)
  tile?: number;
  jitter?: number;
  rand?: number; // chance of an off-the-cuff random legal move
}
/**
 * Per-personality biases. These OVERRIDE the difficulty baseline's threat/pen/
 * tile coefficients (when present) so each farmer makes visibly different
 * decisions. Magnitudes are sized to actually swing the argmax against raw
 * acre-gain, not just break ties. Tuned via the self-play probe to stay
 * roughly competitive (no style is a pushover).
 */
const STYLES: Record<FarmerStyle, StyleCfg> = {
  opportunist: {}, // baseline — take the best acres on offer
  guardian: { threat: 1.8, pen: 0.15 }, // defensive — won't gift a near-done field
  cultivator: { pen: 0.6, tile: 0.35, threat: 0.3 }, // patient builder, lays more
  minimalist: { tile: -0.6, pen: 0.04, jitter: 2e-4 }, // terse, decisive, few tiles
  tactician: { pen: -0.15, threat: 0.8, tile: -0.05 }, // closer — won't faff half-building
  landgrabber: { tile: 0.5, pen: 0.3, threat: 0.05 }, // greedy expansion, ignores risk
  steady: { threat: 1.2, pen: 0.18, tile: -0.1, jitter: 2e-4 }, // cautious, conservative, low variance
  wildcard: { jitter: 0.8, rand: 0.1 }, // unpredictable
};

interface ResolvedWeights extends Weights {
  rand: number;
}
function resolveWeights(diff: Difficulty, style?: FarmerStyle): ResolvedWeights {
  const b = WEIGHTS_BASE[diff];
  const s = style ? STYLES[style] : {};
  // easy stays gain-only (weak) regardless of style; medium+ takes the overrides
  if (diff === "easy") return { ...b, rand: s.rand ?? 0 };
  return {
    gain: b.gain,
    threat: s.threat ?? b.threat,
    pen: s.pen ?? b.pen,
    tile: s.tile ?? b.tile,
    jitter: s.jitter ?? b.jitter,
    rand: s.rand ?? 0,
  };
}

/** Heuristic value of a candidate move from the mover's perspective. */
function heuristic(board: Board, move: Move, w: Weights): { v: number; gain: number; after: Board } {
  const after = board.clone();
  const gain = applyAndScore(after, move);
  // skip the pocket scan when no term needs it (cheap path for easy)
  if (w.threat === 0 && w.pen === 0 && w.tile === 0) return { v: gain * w.gain, gain, after };
  const { pens, threats } = pocketStats(after);
  return { v: gain * w.gain - w.threat * threats + w.pen * pens + w.tile * move.tiles.length, gain, after };
}

function pickGreedy(board: Board, hand: Tile[], diff: Difficulty, style: FarmerStyle | undefined, rng: Rng): Move | null {
  const moves = generateMoves(board, hand, { limit: BREADTH[diff] });
  if (moves.length === 0) return null;
  const w = resolveWeights(diff, style);
  if (diff === "easy" && rng() < 0.5) return moves[Math.floor(rng() * moves.length)];
  if (w.rand > 0 && rng() < w.rand) return moves[Math.floor(rng() * moves.length)];
  let best = moves[0];
  let bestV = -Infinity;
  for (const m of moves) {
    const v = heuristic(board, m, w).v + rng() * w.jitter;
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
  const unseen = buildBag(game.players.length).filter((t) => !onBoard.has(t.id) && !myHandIds.has(t.id));
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

/** Cheap rollout policy: random-ish legal move (single-tile only, tight effort cap). */
function pickRandom(board: Board, hand: Tile[], rng: Rng): Move | null {
  const moves = generateMoves(board, hand, { limit: 10, maxLay: 1, maxNodes: 800 });
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

const clock = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

const ROOT_K = 12; // MCTS concentrates on the heuristic's best dozen candidates

function expertMove(game: Game, me: number, rng: Rng, iterations: number, maxMs: number, style?: FarmerStyle): Move | null {
  let root = generateMoves(game.board, game.players[me].hand, { limit: BREADTH.expert });
  if (root.length === 0) return null;
  if (root.length === 1) return root[0];

  // Pre-rank by the strong heuristic (with the farmer's personality) and keep
  // the top-K so each surviving arm gets enough rollouts to matter.
  const w = resolveWeights("expert", style);
  let scored = root.map((m) => ({ m, h: heuristic(game.board, m, w).v }));
  scored.sort((a, b) => b.h - a.h);
  if (scored.length > ROOT_K) scored = scored.slice(0, ROOT_K);
  root = scored.map((s) => s.m);
  const prior = scored.map((s) => s.h); // heuristic value, used as a strong prior

  const n = root.length;
  const visits = new Array(n).fill(0);
  const total = new Array(n).fill(0);
  const C = 1.3;
  const start = clock();

  for (let it = 0; it < iterations; it++) {
    // wall-clock budget: never block the UI for long regardless of board size
    if (it > 0 && clock() - start > maxMs) break;
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
    const margin = rollout(s, me, rng, 18);
    visits[arm]++;
    total[arm] += margin;
  }

  // Final score blends the heuristic prior (reliable) with the MCTS rollout
  // margin (refines among the heuristic's best). Keeps expert >= hard while
  // letting search break ties and spot deeper enclosure timing.
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < n; i++) {
    const mean = visits[i] > 0 ? total[i] / visits[i] : 0;
    const score = prior[i] + 0.15 * mean;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return root[best];
}

export interface AiOptions {
  rng?: Rng;
  iterations?: number;
  /** wall-clock budget for the expert search, ms (keeps the UI responsive) */
  maxMs?: number;
}

/** Choose a move for the current player, or null to pass. */
export function chooseAiMove(game: Game, opts: AiOptions = {}): Move | null {
  const rng = opts.rng ?? Math.random;
  const player = game.currentPlayer;
  const style = player.style;
  if (player.difficulty === "expert") {
    // first move on an empty board: the search tree is huge and rollouts are
    // mostly noise — fall back to the strong heuristic.
    if (game.board.size === 0) return pickGreedy(game.board, player.hand, "hard", style, rng);
    return expertMove(game, game.current, rng, opts.iterations ?? 120, opts.maxMs ?? 300, style);
  }
  return pickGreedy(game.board, player.hand, player.difficulty, style, rng);
}
