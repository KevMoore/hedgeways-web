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

  test("how-to modal opens and closes", async ({ page }) => {
    await page.goto("/");
    await page.locator("#how").click();
    await expect(page.locator(".modal.howto")).toBeVisible();
    await page.locator("#howto-close").click();
    await expect(page.locator(".modal.howto")).toHaveCount(0);
  });
});
