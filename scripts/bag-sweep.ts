/**
 * Bag-size & distribution sweep for Hedgeways playability.
 *
 * Question: 52 tiles feels tuned for 2 players. What bag SIZE and tile-type
 * DISTRIBUTION make 3p / 4p play well — enough land to compete over, fair
 * across seats, and no stalemates?
 *
 * Method: Monte-Carlo self-play with `hard` bots (the strongest AI that never
 * calls buildBag(), so we can inject any custom bag). We override the dealt bag
 * right after construction — the constructor only deals, nothing is on the board
 * yet — then drive the normal turn loop and measure per-game outcomes.
 *
 * Run:  pnpm tsx scripts/bag-sweep.ts            (stage 1: size sweep)
 *       STAGE=2 pnpm tsx scripts/bag-sweep.ts    (stage 2: distribution at fixed sizes)
 *       GAMES=300 pnpm tsx scripts/bag-sweep.ts  (more seeds = tighter means)
 */
import { Game } from "../src/game/game";
import { chooseAiMove } from "../src/game/ai";
import { makeRng, shuffle } from "../src/game/rng";
import { HAND_SIZE } from "../src/game/constants";
import type { Colour, Tile } from "../src/game/types";

// ---------------------------------------------------------------------------
// Colour-balanced tile-type generators.
// Each category set is symmetric under colour permutation, so any integer mix
// of whole sets keeps G/Y/B/P perfectly balanced. Ratios are what matter — we
// cycle the pool up to the target bag size, so only proportions survive.
// ---------------------------------------------------------------------------
const COLOURS: Colour[] = ["G", "Y", "B", "P"];

const MONO: string[] = COLOURS.map((c) => c + c + c); // GGG YYY BBB PPP  (4)

// pair = 2 colours: for each unordered {a,b} include aab & abb (balanced)
const PAIR: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < COLOURS.length; i++)
    for (let j = i + 1; j < COLOURS.length; j++) {
      const a = COLOURS[i], b = COLOURS[j];
      out.push(a + a + b, a + b + b);
    }
  return out; // 6 pairs × 2 = 12
})();

// tri = 3 distinct colours, all permutations of each 3-subset (balanced)
const TRI: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < COLOURS.length; i++)
    for (let j = 0; j < COLOURS.length; j++)
      for (let k = 0; k < COLOURS.length; k++)
        if (i !== j && j !== k && i !== k) out.push(COLOURS[i] + COLOURS[j] + COLOURS[k]);
  return out; // 4·3·2 = 24
})();

interface Mix {
  name: string;
  mono: number; // how many copies of the MONO set
  pair: number;
  tri: number;
}
// canonical = the shipping 52-tile proportions: mono 7.7% / pair 46% / tri 46%.
// MONO set=4, PAIR set=12, TRI set=24, so 1:2:1 copies → 4/24/24 tiles exactly.
const CANONICAL: Mix = { name: "canonical", mono: 1, pair: 2, tri: 1 };

function poolFor(mix: Mix): string[] {
  const out: string[] = [];
  for (let i = 0; i < mix.mono; i++) out.push(...MONO);
  for (let i = 0; i < mix.pair; i++) out.push(...PAIR);
  for (let i = 0; i < mix.tri; i++) out.push(...TRI);
  return out;
}

function toTile(code: string, id: number): Tile {
  const s = code.split("") as Colour[];
  return { id, segments: [s[0], s[1], s[2]] };
}

/** Build a bag of exactly `size` tiles from a mix, preserving proportions &
 *  colour balance. Shuffle the pool deterministically, then cycle to size so a
 *  partial last block is a representative sample (not a biased prefix). */
function buildBag(size: number, mix: Mix, seed: number): Tile[] {
  const pool = shuffle(poolFor(mix), makeRng(seed >>> 0));
  return Array.from({ length: size }, (_, i) => toTile(pool[i % pool.length], i));
}

// ---------------------------------------------------------------------------
// Self-play
// ---------------------------------------------------------------------------
interface Stats {
  commits: number;
  skips: number;
  deadlock: boolean;
  tilesLaid: number;
  tilesLeft: number;
  acres: number[];
  minLegal: number; // tightest board the mover actually faced
}

function placedTiles(g: Game): number {
  const ids = new Set<number>();
  for (const c of g.board.cells.values()) ids.add(c.tileId);
  return ids.size;
}

function playGame(nPlayers: number, size: number, mix: Mix, seed: number): Stats {
  const g = new Game({
    seed,
    players: Array.from({ length: nPlayers }, (_, i) => ({ name: `P${i}`, isBot: true, difficulty: "hard" as const })),
  });
  // inject the custom bag: re-deal from it (board is empty post-construction)
  const bag = buildBag(size, mix, seed ^ 0xbade5);
  g.bag = bag;
  for (const p of g.players) {
    p.hand = g.bag.splice(0, HAND_SIZE);
    p.score = 0;
  }

  const rng = makeRng(seed ^ 0x9e3779b9);
  let commits = 0, skips = 0, deadlock = false, minLegal = Infinity, safety = 0;
  while (!g.gameOver && safety++ < 20000) {
    // cheap tightness probe: cap at 20 — we only need to know if the board is
    // near-locked, not the true branching factor (which is costly on big boards)
    if (g.turn % 8 === 0) minLegal = Math.min(minLegal, g.legalMoves(20).length);
    const move = chooseAiMove(g, { rng });
    if (move) {
      g.commit(move);
      commits++;
    } else {
      const r = g.skipStuck();
      skips++;
      if (r.ended) deadlock = true;
    }
  }
  return {
    commits,
    skips,
    deadlock,
    tilesLaid: placedTiles(g),
    tilesLeft: g.bag.length + g.players.reduce((n, p) => n + p.hand.length, 0),
    acres: g.players.map((p) => p.score),
    minLegal: minLegal === Infinity ? 0 : minLegal,
  };
}

interface Row {
  n: number;
  size: number;
  mix: string;
  games: number;
  tppDealt: number; // tiles per player (size / n) — the per-capita budget
  turnsPerPlayer: number; // scoring/placement turns per player
  L: number; // avg tiles laid per turn
  laidPerPlayer: number;
  totalAcres: number;
  acresPerPlayer: number;
  efficiency: number; // acres per tile laid
  margin: number; // 1st − 2nd, by acres
  closeness: number; // margin / fair-share (lower = closer game)
  seatAdv: number; // seat-0 win share × n (1.0 = fair)
  deadlockPct: number;
  skipsPerGame: number;
  minLegalAvg: number; // tightest board faced (avg over games)
  wastePct: number; // tiles never laid, % of bag
}

function run(nPlayers: number, size: number, mix: Mix, games: number): Row {
  const runs: Stats[] = [];
  for (let i = 0; i < games; i++) runs.push(playGame(nPlayers, size, mix, 1000 + i * 7919));
  const avg = (f: (s: Stats) => number) => runs.reduce((a, s) => a + f(s), 0) / games;

  let seat0Wins = 0;
  let marginSum = 0;
  for (const s of runs) {
    const sorted = [...s.acres].sort((a, b) => b - a);
    marginSum += sorted[0] - (sorted[1] ?? 0);
    const max = Math.max(...s.acres);
    // count a seat-0 win only on a clean (untied) top to avoid inflating ties
    if (s.acres[0] === max && s.acres.filter((a) => a === max).length === 1) seat0Wins++;
  }
  const totalAcres = avg((s) => s.acres.reduce((a, b) => a + b, 0));
  const fairShare = totalAcres / nPlayers;
  const margin = marginSum / games;
  return {
    n: nPlayers,
    size,
    mix: mix.name,
    games,
    tppDealt: size / nPlayers,
    turnsPerPlayer: avg((s) => s.commits) / nPlayers,
    L: avg((s) => s.tilesLaid) / Math.max(1, avg((s) => s.commits)),
    laidPerPlayer: avg((s) => s.tilesLaid) / nPlayers,
    totalAcres,
    acresPerPlayer: totalAcres / nPlayers,
    efficiency: totalAcres / Math.max(1, avg((s) => s.tilesLaid)),
    margin,
    closeness: margin / Math.max(0.01, fairShare),
    seatAdv: (seat0Wins / games) * nPlayers,
    deadlockPct: (runs.filter((s) => s.deadlock).length / games) * 100,
    skipsPerGame: avg((s) => s.skips),
    minLegalAvg: avg((s) => s.minLegal),
    wastePct: (avg((s) => s.tilesLeft) / size) * 100,
  };
}

const COLS: [string, (r: Row) => string][] = [
  ["n", (r) => String(r.n)],
  ["bag", (r) => String(r.size)],
  ["mix", (r) => r.mix],
  ["t/plyr", (r) => r.tppDealt.toFixed(1)],
  ["turns/p", (r) => r.turnsPerPlayer.toFixed(1)],
  ["L", (r) => r.L.toFixed(2)],
  ["acres", (r) => r.totalAcres.toFixed(1)],
  ["acr/p", (r) => r.acresPerPlayer.toFixed(1)],
  ["eff", (r) => r.efficiency.toFixed(3)],
  ["margin", (r) => r.margin.toFixed(2)],
  ["close", (r) => r.closeness.toFixed(2)],
  ["seat0×n", (r) => r.seatAdv.toFixed(2)],
  ["dead%", (r) => r.deadlockPct.toFixed(1)],
  ["skip/g", (r) => r.skipsPerGame.toFixed(2)],
  ["minLgl", (r) => r.minLegalAvg.toFixed(0)],
  ["waste%", (r) => r.wastePct.toFixed(1)],
];
const HEADER = COLS.map(([h]) => h.padStart(8)).join("");
function printHeader() {
  console.log(HEADER);
  console.log("-".repeat(HEADER.length));
}
function printRow(r: Row) {
  console.log(COLS.map(([, f]) => f(r).padStart(8)).join(""));
}

// ---------------------------------------------------------------------------
const GAMES = Number(process.env.GAMES ?? 200);
const STAGE = Number(process.env.STAGE ?? 1);

console.log(`Hedgeways bag sweep — ${GAMES} games/cell, hard bots\n`);
console.log("Legend:");
console.log("  t/plyr   = bag size / players (per-capita tile budget)");
console.log("  turns/p  = placement turns per player   L = avg tiles laid/turn");
console.log("  acres    = total land enclosed   eff = acres per tile laid");
console.log("  margin   = winner − runner-up (acres)   close = margin / fair-share (lower=closer)");
console.log("  seat0×n  = first-seat win share × players (1.0 = fair, >1 = first-mover edge)");
console.log("  dead%    = games ending in all-pass deadlock   skip/g = stuck passes/game");
console.log("  minLgl   = tightest legal-move count faced (avg)   waste% = tiles never laid\n");

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(0);
printHeader();

if (STAGE === 1) {
  // common bag-size grid; read tppDealt to compare equivalent per-capita budgets
  const SIZES = [39, 52, 65, 78, 91, 104, 130];
  for (const n of [2, 3, 4]) {
    for (const size of SIZES) {
      const r = run(n, size, CANONICAL, GAMES);
      printRow(r);
      process.stderr.write(`  [${elapsed()}s] done n=${n} bag=${size}\n`);
    }
    console.log("-".repeat(HEADER.length));
  }
} else {
  // stage 2: at the per-player budget that stage 1 favours, compare tile-type
  // mixes for stalemate-resistance & land productivity
  const MIXES: Mix[] = [
    { name: "canonical", mono: 1, pair: 2, tri: 1 }, // 7.7/46/46  (shipping)
    { name: "flexMono", mono: 4, pair: 2, tri: 1 }, // 25/37/37 — boost versatile mono joiners
    { name: "triHeavy", mono: 1, pair: 1, tri: 2 }, // 6/19/75 — more 3-colour matchers
    { name: "lowPair", mono: 2, pair: 1, tri: 2 }, // 12/18/70 — strip rigid pairs
  ];
  for (const [n, size] of [[2, 52], [3, 78], [4, 104]] as [number, number][]) {
    for (const mix of MIXES) {
      const r = run(n, size, mix, GAMES);
      printRow(r);
      process.stderr.write(`  [${elapsed()}s] done n=${n} bag=${size} mix=${mix.name}\n`);
    }
    console.log("-".repeat(HEADER.length));
  }
}
