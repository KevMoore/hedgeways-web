import { expect, test } from "@playwright/test";

test.describe("Hedgeways smoke", () => {
  test("start screen renders and starts a game", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".logo")).toContainText("Hedge");
    await page.locator("#play").click();
    await expect(page.locator("canvas.board")).toBeVisible();
    await expect(page.locator(".players .pchip").first()).toBeVisible();
  });

  test("autoPlayTurn drives a few moves via the test hook", async ({ page }) => {
    await page.goto("/");
    await page.locator("#play").click();
    // play 6 turns through the test hook
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => (window as any).__hedge.autoPlayTurn());
    }
    const state = await page.evaluate(() => (window as any).__hedge.state());
    expect(typeof state.bag).toBe("number");
    expect(Array.isArray(state.scores)).toBe(true);
  });

  test("human can place a hedge by tapping a highlighted cell", async ({ page }) => {
    await page.goto("/");
    await page.locator("#play").click();
    await expect(page.locator("canvas.board")).toBeVisible();

    await page.locator(".hand .tile").first().click();
    await expect(page.locator(".hand .tile.sel")).toHaveCount(1);

    // tap a highlighted (legal) cell — any covered cell, not just the anchor
    const target = await page.evaluate(() => {
      const ui = (window as any).__hedge.ui;
      const sc = ui.scene;
      const hl = [...sc.highlights];
      const [x, y] = hl[Math.floor(hl.length / 2)].split(",").map(Number);
      const canvas = document.querySelector("canvas.board") as HTMLCanvasElement;
      const r = canvas.getBoundingClientRect();
      const vw = canvas.width / sc.dpr;
      const vh = canvas.height / sc.dpr;
      return {
        X: r.left + vw / 2 + (x + 0.5 - sc.camX) * sc.scale,
        Y: r.top + vh / 2 + (y + 0.5 - sc.camY) * sc.scale,
      };
    });
    await page.mouse.click(target.X, target.Y);

    expect((await page.evaluate(() => (window as any).__hedge.state())).pending).toBe(1);
    await expect(page.locator("#btn-confirm")).toBeEnabled();
    await page.locator("#btn-confirm").click();
    // after confirming, a hedge is on the board (bag drew replacements; turn advanced)
    await expect(page.locator("canvas.board")).toBeVisible();
  });

  test("the hand and controls are visible within the viewport", async ({ page }) => {
    await page.goto("/");
    await page.locator("#play").click();
    await expect(page.locator(".hand .tile").first()).toBeVisible();
    const vh = page.viewportSize()!.height;
    const hand = await page.locator(".hand").boundingBox();
    const confirm = await page.locator("#btn-confirm").boundingBox();
    expect(hand).not.toBeNull();
    // hand and the Confirm button must sit inside the viewport, not pushed off-screen
    expect(hand!.y + hand!.height).toBeLessThanOrEqual(vh + 1);
    expect(confirm!.y + confirm!.height).toBeLessThanOrEqual(vh + 1);
  });

  test("a game auto-saves and can be resumed after reload", async ({ page }) => {
    await page.goto("/");
    await page.locator("#play").click();
    for (let i = 0; i < 4; i++) await page.evaluate(() => (window as any).__hedge.autoPlayTurn());
    const before = await page.evaluate(() => (window as any).__hedge.ui.game.board.size);
    expect(before).toBeGreaterThan(0);

    await page.reload();
    const resume = page.locator("#resume");
    await expect(resume).toBeVisible();
    await resume.click();
    await expect(page.locator("canvas.board")).toBeVisible();
    const after = await page.evaluate(() => (window as any).__hedge.ui.game.board.size);
    expect(after).toBe(before); // board restored exactly
  });

  test("restart from the game menu starts a fresh board", async ({ page }) => {
    await page.goto("/");
    await page.locator("#play").click();
    for (let i = 0; i < 4; i++) await page.evaluate(() => (window as any).__hedge.autoPlayTurn());
    await page.locator("#btn-quit").click();
    await page.locator("#q-restart").click();
    await expect(page.locator("canvas.board")).toBeVisible();
    const size = await page.evaluate(() => (window as any).__hedge.ui.game.board.size);
    const scores = await page.evaluate(() => (window as any).__hedge.state().scores);
    expect(size).toBe(0);
    expect(scores.every((s: number) => s === 0)).toBe(true);
  });

  test("how-to modal opens and closes", async ({ page }) => {
    await page.goto("/");
    await page.locator("#how").click();
    await expect(page.locator(".modal.howto")).toBeVisible();
    await page.locator("#howto-close").click();
    await expect(page.locator(".modal.howto")).toHaveCount(0);
  });
});
