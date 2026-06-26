import { test, expect, Page } from "@playwright/test";
import * as fs from "fs";

// ──────────────────────────────────────────────────────────────────────────
// Overnight exploratory "play" harness. NOT part of the normal suite — it
// actually plays Hedgeways through the real UI (tap/rotate/undo/confirm and
// touch-drag on mobile) plus a fast engine-only volume path, hunting for:
//   • uncaught exceptions / console.error
//   • tile-conservation invariant breaks (bag + hands + board === BAG_SIZE)
//   • turns that stall (bot never hands back, or a game that never ends)
// Findings are appended to /tmp/hedge-findings.md for the morning report.
// Tunable via env: PLAY_GAMES, PLAY_INT_GAMES, PLAY_MOVE_CAP.
// ──────────────────────────────────────────────────────────────────────────

const FINDINGS = "/tmp/hedge-findings.md";
const VOL_GAMES = Number(process.env.PLAY_GAMES ?? 8);
const INT_GAMES = Number(process.env.PLAY_INT_GAMES ?? 3);
const MOVE_CAP = Number(process.env.PLAY_MOVE_CAP ?? 600);
// Interactive games are slow (bot turns animate), so we don't run them to the
// end — a bounded run of human turns per session exercises the UI plenty.
const INT_TURNS = Number(process.env.PLAY_INT_TURNS ?? 8);
// Player count for the games we start (2–4). Default 2; set PLAY_PLAYERS=4 to
// exercise the denser multi-player boards (bag scaling, more enclosures).
const PLAYERS = Math.min(4, Math.max(2, Number(process.env.PLAY_PLAYERS ?? 2)));

function record(line: string) {
  fs.appendFileSync(FINDINGS, line + "\n");
  console.log(line);
}

/** Wire console + pageerror capture; returns a getter for collected problems. */
function watch(page: Page, tag: string): () => string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      const t = m.text();
      // jsdom/network noise we don't care about
      if (/Failed to load resource|favicon|net::ERR/i.test(t)) return;
      problems.push(`[console.error] ${tag}: ${t}`);
    }
  });
  page.on("pageerror", (e) => problems.push(`[pageerror] ${tag}: ${e.message}`));
  return () => problems;
}

/** Snapshot the engine + assert the tile-conservation invariant. */
async function invariant(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const g = (window as any).__hedge.ui.game;
    const onBoard = new Set<number>();
    for (const cell of g.board.cells.values()) onBoard.add(cell.tileId);
    const inHands = g.players.reduce((s: number, p: any) => s + p.hand.length, 0);
    const total = g.bag.length + inHands + onBoard.size;
    const expect0 = (window as any).__hedgeTotal0;
    if (expect0 != null && total !== expect0) {
      return `invariant broke: bag(${g.bag.length}) + hands(${inHands}) + board(${onBoard.size}) = ${total}, expected ${expect0}`;
    }
    return null;
  });
}

async function startFresh(page: Page) {
  await page.goto("/");
  // pick the player count (default 2; human + bots fill the rest)
  if (PLAYERS > 2) await page.locator(`#count button[data-n="${PLAYERS}"]`).click().catch(() => {});
  // #play always starts a brand-new game (ignoring any Resume offer) for a clean seed
  await page.locator("#play").click();
  await page.locator("canvas.board").waitFor();
  await page.waitForTimeout(300);
  // capture the conservation total at t0 (board empty) + actual player count
  const np = await page.evaluate(() => {
    const g = (window as any).__hedge.ui.game;
    const inHands = g.players.reduce((s: number, p: any) => s + p.hand.length, 0);
    (window as any).__hedgeTotal0 = g.bag.length + inHands;
    return g.players.length;
  });
  if (np !== PLAYERS) record(`⚠️ player-count select failed: wanted ${PLAYERS}, got ${np}`);
}

async function restart(page: Page) {
  // Bulletproof reset: a full reload guarantees a clean DOM — no lingering end
  // modal / confetti overlay to confuse button clicks (which caused strict-mode
  // "2 × #end-again" and "modal-back intercepts pointer events" flakes). The
  // app auto-saves, so the start screen may offer Resume; startFresh clicks Play
  // to begin a brand-new game regardless.
  await startFresh(page);
}

// ── Fast volume path: drive whole games via the hook, check invariant + errors.
test("volume: play many games fast via the hook", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const tag = testInfo.project.name;
  const getProblems = watch(page, tag);
  await startFresh(page);
  let crashes = 0;

  // More players → bigger bag (104 at 4p) → longer games, so scale the game count
  // down with seat count to keep the run inside the wall-clock budget.
  const effVolGames = Math.max(4, Math.round((VOL_GAMES * 2) / PLAYERS));
  for (let game = 0; game < effVolGames; game++) {
    let moves = 0;
    while (moves < MOVE_CAP) {
      const over = await page.evaluate(() => (window as any).__hedge.state().gameOver);
      if (over) break;
      await page.evaluate(() => (window as any).__hedge.autoPlayTurn());
      moves++;
      if (moves % 12 === 0) {
        const bad = await invariant(page);
        if (bad) {
          record(`❌ [${tag}] volume game ${game} move ${moves}: ${bad}`);
          crashes++;
          break;
        }
      }
    }
    if (moves >= MOVE_CAP) record(`⚠️ [${tag}] volume game ${game} hit MOVE_CAP ${MOVE_CAP} without ending (possible non-termination)`);
    const probs = getProblems();
    if (probs.length) {
      record(`❌ [${tag}] volume game ${game} console/page errors:\n  - ${probs.splice(0).join("\n  - ")}`);
      crashes++;
    }
    if (game < effVolGames - 1) await restart(page);
  }
  record(`✅ [${tag}] volume: ${effVolGames} games (${PLAYERS}p) played, ${crashes} problem-batches`);
  expect(getProblems(), getProblems().join("\n")).toHaveLength(0);
});

// ── Interactive path: a constrained monkey driving the real human-turn UI.
async function cellToScreen(page: Page, cx: number, cy: number) {
  return page.evaluate(
    ([cx, cy]) => {
      const sc = (window as any).__hedge.ui.scene;
      const c = document.querySelector("canvas.board") as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      const vw = c.width / sc.dpr;
      const vh = c.height / sc.dpr;
      return {
        X: r.left + vw / 2 + (cx + 0.5 - sc.camX) * sc.scale,
        Y: r.top + vh / 2 + (cy + 0.5 - sc.camY) * sc.scale,
      };
    },
    [cx, cy],
  );
}

/** Pick an empty cell adjacent to an existing hedge (or origin on an empty board). */
async function pickTargetCell(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const g = (window as any).__hedge.ui.game;
    const occ = new Set<string>(g.board.cells.keys());
    if (occ.size === 0) return { x: 0, y: 0 };
    const keys = [...occ];
    for (let tries = 0; tries < 40; tries++) {
      const k = keys[Math.floor(Math.random() * keys.length)];
      const [x, y] = k.split(",").map(Number);
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const [dx, dy] = dirs[Math.floor(Math.random() * 4)];
      const nk = `${x + dx},${y + dy}`;
      if (!occ.has(nk) && !g.board.enclosed.has(nk)) return { x: x + dx, y: y + dy };
    }
    return { x: 0, y: 0 };
  });
}

/** Drive one human turn through the real UI; returns true if the turn advanced. */
async function humanTurn(page: Page): Promise<boolean> {
  const rnd = (n: number) => Math.floor(Math.random() * n);
  const tiles = page.locator(".hand .tile:not(.used)");
  const n = await tiles.count();
  if (n === 0) return false;
  // place 1–2 hedges this turn
  const lay = 1 + rnd(2);
  for (let i = 0; i < lay; i++) {
    const avail = page.locator(".hand .tile:not(.used)");
    if ((await avail.count()) === 0) break;
    await avail.nth(rnd(await avail.count())).click();
    // maybe rotate a few times via the new button
    const rot = rnd(4);
    for (let r = 0; r < rot; r++) await page.locator("#btn-rotate").click().catch(() => {});
    const cell = await pickTargetCell(page);
    const pt = await cellToScreen(page, cell.x, cell.y);
    await page.mouse.click(pt.X, pt.Y);
    await page.waitForTimeout(60);
  }
  // try to confirm
  const confirm = page.locator("#btn-confirm");
  if (await confirm.isEnabled().catch(() => false)) {
    await confirm.click();
    await page.waitForTimeout(120);
    const st = await page.evaluate(() => (window as any).__hedge.state());
    if (st.pending === 0) return true; // accepted (turn advanced or pending cleared)
  }
  // couldn't make a legal move via the monkey — undo everything, fall back
  for (let u = 0; u < 4; u++) await page.locator("#btn-undo").click().catch(() => {});
  await page.evaluate(() => (window as any).__hedge.autoPlayTurn());
  return true;
}

/** Wait until it's the human's turn again (current===0) or the game ends. */
async function waitForHuman(page: Page, ms = 20_000): Promise<"human" | "over" | "stalled"> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await page.evaluate(() => (window as any).__hedge.state());
    if (st.gameOver) return "over";
    if (st.current === 0) return "human";
    await page.waitForTimeout(200);
  }
  return "stalled";
}

test("interactive: monkey plays human turns through the real UI", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const tag = testInfo.project.name;
  const getProblems = watch(page, tag);
  await startFresh(page);
  let issues = 0;

  // Each extra player adds an animated bot turn between our human turns, so a
  // fixed turn budget blows the wall-clock at 3–4 players. Scale turns AND games
  // down with player count so a session stays bounded (and never times out) no
  // matter the seat count — the volume path already covers multi-player logic.
  const effTurns = Math.max(2, Math.round((INT_TURNS * 2) / PLAYERS));
  const effGames = Math.max(2, Math.round((INT_GAMES * 2) / PLAYERS));

  for (let game = 0; game < effGames; game++) {
    let humanTurns = 0;
    gameLoop: while (humanTurns < effTurns) {
      const st = await page.evaluate(() => (window as any).__hedge.state());
      if (st.gameOver) break;
      if (st.current === 0) {
        await humanTurn(page);
        humanTurns++;
        const bad = await invariant(page);
        if (bad) { record(`❌ [${tag}] interactive game ${game} turn ${humanTurns}: ${bad}`); issues++; break; }
      } else {
        const r = await waitForHuman(page);
        if (r === "stalled") {
          record(`❌ [${tag}] interactive game ${game}: bot turn STALLED >20s (current=${st.current}) — possible soft-lock`);
          await page.screenshot({ path: `/tmp/hedge-stall-${tag}-${game}.png` });
          issues++;
          break gameLoop;
        }
        if (r === "over") break;
      }
    }
    const probs = getProblems();
    if (probs.length) { record(`❌ [${tag}] interactive game ${game} errors:\n  - ${probs.splice(0).join("\n  - ")}`); issues++; }
    await page.screenshot({ path: `/tmp/hedge-int-${tag}-${game}.png` });
    if (game < effGames - 1) await restart(page);
  }
  record(`✅ [${tag}] interactive: ${effGames} games (${PLAYERS}p, ${effTurns} turns), ${issues} issues`);
  expect(getProblems(), getProblems().join("\n")).toHaveLength(0);
});
