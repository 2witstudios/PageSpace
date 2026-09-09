import { defineConfig } from "@playwright/test";

/** Capture runs on its own port so it never reuses (or fights) the dev server. */
const CAPTURE_PORT = 3005;
const CAPTURE_URL = `http://localhost:${CAPTURE_PORT}`;

export default defineConfig({
  testDir: "./scripts",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: CAPTURE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    // CAPTURE=1 turns off Next's dev indicator, which otherwise renders into
    // the exported screenshots. See next.config.ts.
    command: `CAPTURE=1 npx next dev --port ${CAPTURE_PORT}`,
    url: CAPTURE_URL,
    // Never reuse. A server already running from a plain `bun run dev` has no
    // CAPTURE=1, so devIndicators stays on and Next's dev badge renders into
    // the exported screenshots — which is exactly what happened, invisibly,
    // until a 1:1 crop showed the badge in the corner of every frame.
    //
    // The dedicated port is what makes that safe to enforce: capture boots its
    // own server instead of colliding with the dev server on 3004.
    reuseExistingServer: false,
    timeout: 120 * 1000,
  },
});
