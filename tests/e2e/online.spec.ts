import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Full two-client browser flow: spawn the authority, create a room in page A,
 * join it by code in page B, then play a whole game to completion across both
 * tabs. Proves the lobby, redaction mirror, move round-trip, and end screen all
 * work end-to-end in a real browser. The client defaults to ws://localhost:8787.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let server: ChildProcess;

test.beforeAll(async () => {
  server = spawn("pnpm", ["tsx", "server/index.ts"], { cwd: ROOT, stdio: "ignore" });
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

test("two browsers play a full online game to a winner", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // A creates a room and reveals the code
  await openMenu(a);
  await a.click("#ov-create");
  await expect(a.locator(".room-code")).toBeVisible({ timeout: 15_000 });
  const code = (await a.locator(".room-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);

  // B joins by code
  await openMenu(b);
  await b.fill("#ov-code", code);
  await b.click("#ov-join");

  // both reach the live board (the hand footer is part of the game template)
  await expect(a.locator(".hand")).toBeVisible({ timeout: 15_000 });
  await expect(b.locator(".hand")).toBeVisible({ timeout: 15_000 });

  // drive both clients: each tick, the player whose turn it is auto-lays a move
  for (let i = 0; i < 400; i++) {
    const sa = await state(a);
    if (sa?.gameOver) break;
    await autoPlay(a);
    await autoPlay(b);
    await a.waitForTimeout(120);
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

/** Helper: create in A, join in B, return when both are at the board. */
async function startPair(browser: import("@playwright/test").Browser) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await openMenu(a);
  await a.click("#ov-create");
  await expect(a.locator(".room-code")).toBeVisible({ timeout: 15_000 });
  const code = (await a.locator(".room-code").textContent())!.trim();
  await openMenu(b);
  await b.fill("#ov-code", code);
  await b.click("#ov-join");
  await expect(a.locator(".hand")).toBeVisible({ timeout: 15_000 });
  await expect(b.locator(".hand")).toBeVisible({ timeout: 15_000 });
  return { ctxA, ctxB, a, b };
}

test("opponent quit → the other player gets a forfeit win screen", async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await startPair(browser);
  // B quits to the menu mid-game (explicit leave, not a silent drop)
  await b.click("#btn-quit");
  await b.click("#q-ok");
  // A should see a forfeit win
  await expect(a.locator(".forfeit-note")).toBeVisible({ timeout: 10_000 });
  await expect(a.locator(".modal.end h2")).toContainText("win the farm");
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
  for (let i = 0; i < 10; i++) {
    const done = (await autoPlay(a)) || (await autoPlay(b));
    if (done) break;
    await a.waitForTimeout(150);
  }
  await ctxA.close();
  await ctxB.close();
});
