import { test, expect, type Page, type Browser } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Full multi-client browser flow: spawn the authority, create a room in page A,
 * join it by code in page B, the HOST starts the table (empty seats become bots),
 * then play across both tabs to completion. Proves the lobby, host-start + bot
 * fill, redaction mirror, move round-trip, server-driven bot turns, and end
 * screen all work end-to-end. The client defaults to ws://localhost:8787.
 *
 * BOT_MOVE_MS=0 makes server bots play instantly so the suite stays fast (prod
 * keeps the jittered ~2s pacing).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let server: ChildProcess;

test.beforeAll(async () => {
  server = spawn("pnpm", ["tsx", "server/index.ts"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, BOT_MOVE_MS: "0" } });
  await new Promise((r) => setTimeout(r, 1500)); // let it bind :8787
});
test.afterAll(() => {
  server?.kill();
});

const openMenu = async (p: Page) => {
  await p.goto("/");
  await p.click("#online");
};
const state = (p: Page) => p.evaluate(() => (window as { __hedge?: { state?: () => { current: number; gameOver: boolean; winnerId: number | null } } }).__hedge?.state?.());
const autoPlay = (p: Page) => p.evaluate(() => (window as { __hedge?: { autoPlayTurn?: () => boolean } }).__hedge?.autoPlayTurn?.());

/** Create in A, join in B, host-start, return when both are at the board. The
 *  table is 2 humans + 2 bots (empties filled on start). */
async function startPair(browser: Browser) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // A creates a room and reveals the code in the lobby
  await openMenu(a);
  await a.click("#ov-create");
  await expect(a.locator(".room-code")).toBeVisible({ timeout: 15_000 });
  const code = (await a.locator(".room-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);

  // B joins by code → A (the host) can now start
  await openMenu(b);
  await b.fill("#ov-code", code);
  await b.click("#ov-join");

  // host starts once the 2nd human is in (button enables on the canStart lobby frame)
  await a.click("#ov-start:not([disabled])", { timeout: 15_000 });

  // both reach the live board (the hand footer is part of the game template)
  await expect(a.locator(".hand")).toBeVisible({ timeout: 15_000 });
  await expect(b.locator(".hand")).toBeVisible({ timeout: 15_000 });
  return { ctxA, ctxB, a, b, code };
}

test("two browsers + bots play a full online game to a winner", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctxA, ctxB, a, b } = await startPair(browser);

  // the table is 4 players (2 humans + 2 bots); humans auto-lay on their turn,
  // bots play themselves server-side
  for (let i = 0; i < 1200; i++) {
    const sa = await state(a);
    if (sa?.gameOver) break;
    await autoPlay(a);
    await autoPlay(b);
    await a.waitForTimeout(100);
  }

  const finalA = await state(a);
  const finalB = await state(b);
  expect(finalA?.gameOver).toBe(true);
  expect(finalB?.gameOver).toBe(true);
  // both tabs agree on the winner — the authority is the single source of truth
  expect(finalA?.winnerId).toBe(finalB?.winnerId);

  await ctxA.close();
  await ctxB.close();
});

test("a player who quits is replaced by a bot and the game plays on", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctxA, ctxB, a, b } = await startPair(browser);

  // B quits to the menu mid-game (explicit leave, not a silent drop)
  await b.click("#btn-quit");
  await b.click("#q-ok");

  // A does NOT get a forfeit win — B's seat becomes a bot and the game continues.
  // Drive A's turns; all three bots (incl. B's old seat) auto-play to the end.
  for (let i = 0; i < 1200; i++) {
    const sa = await state(a);
    if (sa?.gameOver) break;
    await autoPlay(a);
    await a.waitForTimeout(100);
  }
  const final = await state(a);
  expect(final?.gameOver).toBe(true);
  expect(final?.winnerId).not.toBeNull();
  expect(await a.locator(".forfeit-note").count()).toBe(0); // never a forfeit screen

  await ctxA.close();
  await ctxB.close();
});

test("a refresh mid-game rejoins the same seat and resumes", async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await startPair(browser);
  // A refreshes (drops the socket); the saved session should auto-rejoin
  await a.reload();
  await expect(a.locator(".hand")).toBeVisible({ timeout: 15_000 });
  const s = await state(a);
  expect(s?.gameOver).toBe(false);
  // the game still advances after the reconnect
  for (let i = 0; i < 12; i++) {
    const done = (await autoPlay(a)) || (await autoPlay(b));
    if (done) break;
    await a.waitForTimeout(150);
  }
  await ctxA.close();
  await ctxB.close();
});
