import { defineConfig } from "@playwright/test";

const PORT = 5189;
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: BASE, trace: "retain-on-failure" },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: true,
    timeout: 60000,
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1100, height: 800 } } },
    {
      name: "mobile",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
