/**
 * Tile-set analysis for Hedgeways.
 * Static structure of the 52-tile bag + Monte-Carlo self-play playability.
 * Run: pnpm tsx scripts/analyze-tiles.ts
 */
import { TILE_CODES } from "../src/game/bag";
import { Game } from "../src/game/game";
import { chooseAiMove } from "../src/game/ai";
import { makeRng } from "../src/game/rng";
import type { Colour, Difficulty } from "../src/game/types";

const COLOURS: Colour[] = ["G", "Y", "B", "P"];

// ---------- static analysis ----------
function staticAnalysis() {
  const n = COLOURS.length;
  const segCount: Record<string, number> = { G: 0, Y: 0, B: 0, P: 0 };
  const endCount: Record<string, number> = { G: 0, Y: 0, B: 0, P: 0 };
  const midCount: Record<string, number> = { G: 0, Y: 0, B: 0, P: 0 };
  let solids = 0, doubles = 0, rainbows = 0, palindromes = 0;
  const dupes = new Map<string, number>();

  for (const code of TILE_CODES) {
    const [a, b, c] = code.split("");
    segCount[a]++; segCount[b]++; segCount[c]++;
    endCount[a]++; endCount[c]++;
    midCount[b]++;
    const distinct = new Set([a, b, c]).size;
    if (distinct === 1) solids++;
    else if (distinct === 2) doubles++;
    else rainbows++;
    if (a === c) palindromes++;
    // canonical (flip-equivalent) form for dupe detection
    const canon = code <= [...code].reverse().join("") ? code : [...code].reverse().join("");
    dupes.set(canon, (dupes.get(canon) ?? 0) + 1);
  }

  const totalSeg = TILE_CODES.length * 3;
  console.log("=== STATIC TILE-SET ANALYSIS ===");
  console.log(`Tiles: ${TILE_CODES.length}   Segments: ${totalSeg}   (ideal per colour: ${(totalSeg / n).toFixed(1)})`);
  console.log("\nSegment colour balance (all 3 positions):");
  for (const c of COLOURS) {
    const pct = ((segCount[c] / totalSeg) * 100).toFixed(1);
    console.log(`  ${c}: ${String(segCount[c]).padStart(3)}  (${pct}%)`);
  }
  console.log("\nEnd-segment balance (linking surfaces — the join colours):");
  for (const c of COLOURS) {
    const pct = ((endCount[c] / (TILE_CODES.length * 2)) * 100).toFixed(1);
    console.log(`  ${c}: ${String(endCount[c]).padStart(3)}  (${pct}%)`);
  }
  console.log("\nMiddle-segment balance:");
  for (const c of COLOURS) console.log(`  ${c}: ${String(midCount[c]).padStart(3)}`);

  console.log("\nTile-type distribution:");
  console.log(`  Solids   (XXX): ${solids}`);
  console.log(`  Doubles  (XXY): ${doubles}`);
  console.log(`  Rainbows (XYZ): ${rainbows}`);
  console.log(`  Palindromes (X_X, flip-symmetric): ${palindromes}`);

  console.log("\nDuplicate tiles (flip-equivalent, count > 1):");
  const dlist = [...dupes.entries()].filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]);
  if (dlist.length === 0) console.log("  none");
  for (const [k, v] of dlist) console.log(`  ${k} ×${v}`);
  console.log(`  Distinct shapes: ${dupes.size} / ${TILE_CODES.length}`);

  // standard deviation of segment balance as a single "imbalance" number
  const mean = totalSeg / n;
  const variance = COLOURS.reduce((s, c) => s + (segCount[c] - mean) ** 2, 0) / n;
  console.log(`\nColour imbalance (stddev of segment counts): ${Math.sqrt(variance).toFixed(2)}  (0 = perfect)`);
}

// ---------- dynamic / self-play analysis ----------
interface GameStats {
  turns: number;
  totalAcres: number;
  winnerScore: number;
  margin: number;
  passes: number;
  endedByPass: boolean;
  bagLeft: number;
  seatWin: number;
  scoringMoves: number;
  legalSamples: number[];
}

function playGame(nPlayers: number, diff: Difficulty, seed: number): GameStats {
  const rng = makeRng(seed ^ 0x9e3779b9);
  const game = new Game({
    seed,
    players: Array.from({ length: nPlayers }, (_, i) => ({
      name: `P${i}`,
      isBot: true,
      difficulty: diff,
    })),
  });

  let passes = 0;
  let scoringMoves = 0;
  let endedByPass = false;
  const legalSamples: number[] = [];
  let safety = 0;
  while (!game.gameOver && safety++ < 5000) {
    // sample true branching factor (cap high to catch a genuinely tight board)
    if (game.turn % 5 === 0) legalSamples.push(game.legalMoves(2000).length);
    const move = chooseAiMove(game, { rng, iterations: 60, maxMs: 50 });
    if (!move) {
      const r = game.pass();
      passes++;
      if (r.ended) endedByPass = true;
      continue;
    }
    const res = game.commit(move);
    if (res.ok && (res.scored ?? 0) > 0) scoringMoves++;
  }

  const scores = game.players.map((p) => p.score);
  const winnerScore = Math.max(...scores);
  const sorted = [...scores].sort((a, b) => b - a);
  const margin = sorted[0] - (sorted[1] ?? 0);
  return {
    turns: game.turn,
    totalAcres: scores.reduce((a, b) => a + b, 0),
    winnerScore,
    margin,
    passes,
    endedByPass,
    bagLeft: game.bag.length,
    seatWin: game.winnerId ?? -1,
    scoringMoves,
    legalSamples,
  };
}

function summarize(label: string, runs: GameStats[], nPlayers: number) {
  const n = runs.length;
  const avg = (f: (g: GameStats) => number) => (runs.reduce((s, g) => s + f(g), 0) / n);
  const seatWins = new Array(nPlayers).fill(0);
  for (const g of runs) if (g.seatWin >= 0) seatWins[g.seatWin]++;
  const allLegal = runs.flatMap((g) => g.legalSamples);
  const avgLegal = allLegal.length ? allLegal.reduce((a, b) => a + b, 0) / allLegal.length : 0;
  const zeroLegal = allLegal.filter((x) => x === 0).length;
  // tightest board each game actually faced (min legal-move count), averaged
  const avgMinLegal = avg((g) => (g.legalSamples.length ? Math.min(...g.legalSamples) : 0));

  console.log(`\n--- ${label}  (${n} games) ---`);
  console.log(`  avg turns/game ............ ${avg((g) => g.turns).toFixed(1)}`);
  console.log(`  avg total acres scored .... ${avg((g) => g.totalAcres).toFixed(1)}`);
  console.log(`  avg winner score .......... ${avg((g) => g.winnerScore).toFixed(1)}`);
  console.log(`  avg win margin ............ ${avg((g) => g.margin).toFixed(2)}`);
  console.log(`  avg scoring moves/game .... ${avg((g) => g.scoringMoves).toFixed(1)}`);
  console.log(`  avg passes/game ........... ${avg((g) => g.passes).toFixed(2)}`);
  console.log(`  ended by deadlock (pass) .. ${((runs.filter((g) => g.endedByPass).length / n) * 100).toFixed(0)}%   (rest end on last hedge laid)`);
  console.log(`  avg tiles left in bag ..... ${avg((g) => g.bagLeft).toFixed(1)}`);
  console.log(`  avg legal moves (cap 2000)  ${avgLegal.toFixed(0)};  avg tightest board/game: ${avgMinLegal.toFixed(0)};  ${((zeroLegal / Math.max(1, allLegal.length)) * 100).toFixed(1)}% forced pass`);
  console.log(`  seat win distribution ..... [${seatWins.map((w) => ((w / n) * 100).toFixed(0) + "%").join(", ")}]  (fair ≈ ${(100 / nPlayers).toFixed(0)}% each)`);
}

function dynamicAnalysis() {
  console.log("\n\n=== DYNAMIC SELF-PLAY ANALYSIS ===");
  const GAMES = Number(process.env.GAMES ?? 150);
  for (const nPlayers of [2, 3, 4]) {
    for (const diff of ["medium", "hard"] as Difficulty[]) {
      const runs: GameStats[] = [];
      for (let i = 0; i < GAMES; i++) runs.push(playGame(nPlayers, diff, 1000 + i * 7919));
      summarize(`${nPlayers}p · ${diff}`, runs, nPlayers);
    }
  }
}

staticAnalysis();
dynamicAnalysis();
