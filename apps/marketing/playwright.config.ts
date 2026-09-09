import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./scripts",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3004",
    trace: "on-first-retry",
  },
  webServer: {
    // CAPTURE=1 turns off Next's dev indicator, which otherwise renders into
    // the exported screenshots. See next.config.ts.
    command: "CAPTURE=1 bun run dev",
    url: "http://localhost:3004",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
