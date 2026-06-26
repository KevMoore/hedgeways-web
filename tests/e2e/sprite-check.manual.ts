import { test } from "@playwright/test";
import fs from "fs";

// Visual check of the AutoSprite-driven farmer + animal sprites. Not assertions.
test("capture sprites (home + in-game)", async ({ page }) => {
  fs.mkdirSync("test-screens", { recursive: true });
  await page.goto("/");
  await page.waitForTimeout(1800); // let sheets decode + critters animate
  await page.screenshot({ path: "test-screens/home.png" });
  await page.locator("#farmers").screenshot({ path: "test-screens/farmers-row.png" });
  await page.locator("#livestock").screenshot({ path: "test-screens/livestock-row.png" });

  // all-human so autoPlayTurn fully drives pacing to completion
  for (const sel of await page.locator(".slot .slot-type").all()) await sel.selectOption("human").catch(() => {});
  await page.locator("#play").click();
  await page.waitForSelector("canvas.board");
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-screens/in-game.png" });
  // play to the end, then capture the victory tableau
  for (let i = 0; i < 200; i++) {
    const over = await page.evaluate(() => (window as any).__hedge.state?.().gameOver);
    if (over) break;
    await page.evaluate(() => (window as any).__hedge.autoPlayTurn?.());
    await page.waitForTimeout(40);
  }
  await page.waitForSelector(".modal.end", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "test-screens/end.png" });
});
