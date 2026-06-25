import { test } from "@playwright/test";
import fs from "fs";

// Not an assertion test — drives a game via the __hedge hook and zooms in so we
// can eyeball the leafy/twiggy hedge art and that joined tiles are seamless.
test("capture rendered hedges (twigs + seamless joins)", async ({ page }) => {
  await page.goto("/");
  // all-human so autoPlayTurn fully controls pacing (no bot timers re-fitting)
  for (const sel of await page.locator(".slot .slot-type").all()) await sel.selectOption("human");
  await page.locator("#play").click();
  await page.waitForSelector("canvas.board");

  const clearFx = () =>
    page.evaluate(() => document.querySelectorAll(".callout,.confetti").forEach((n) => n.remove()));

  const zoomToBoard = (scale: number) =>
    page.evaluate((sc1: number) => {
      const sc = (window as any).__hedge.ui.scene;
      sc.fitBoard = () => {};
      sc.maybeReframe = () => {};
      const cells = [...(window as any).__hedge.ui.game.board.cells.keys()].map((k: string) =>
        k.split(",").map(Number),
      );
      const xs = cells.map((c: number[]) => c[0]);
      const ys = cells.map((c: number[]) => c[1]);
      sc.camX = sc.tCamX = (Math.min(...xs) + Math.max(...xs)) / 2 + 0.5;
      sc.camY = sc.tCamY = (Math.min(...ys) + Math.max(...ys)) / 2 + 0.5;
      sc.scale = sc.tScale = sc1;
      sc.needsDraw = true;
    }, scale);

  fs.mkdirSync("test-screens", { recursive: true });

  // 1) a single tile, zoomed right in — shows leaves + twigs
  await page.evaluate(() => (window as any).__hedge.autoPlayTurn());
  await zoomToBoard(120);
  await page.waitForTimeout(700);
  await clearFx();
  await page.screenshot({ path: "test-screens/one-tile.png" });

  // 2) several joined tiles — shows the seam-free join between adjacent hedges
  for (let i = 0; i < 6; i++) {
    const over = await page.evaluate(() => (window as any).__hedge.state().gameOver);
    if (over) break;
    await page.evaluate(() => (window as any).__hedge.autoPlayTurn());
  }
  await zoomToBoard(78);
  await page.waitForTimeout(700);
  await clearFx();
  await page.screenshot({ path: "test-screens/joined.png" });

  const size = await page.evaluate(() => (window as any).__hedge.ui.game.board.size);
  console.log(`board has ${size} hedge cells`);
});
