import path from 'path';
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
const mockPort = Number(process.env.E2E_MOCK_OPENROUTER_PORT ?? 4998);
// Playwright hands `storageState` straight to readFile WITHOUT resolving it against the config
// directory, so a relative path here is CWD-relative — while global-setup writes the file next
// to itself. The two only agreed when the runner happened to be started from apps/e2e; from the
// repo root every storageState-backed spec (02-08) died on
// `ENOENT: ./storageState.json`. Anchor it to this file so writer and reader agree from any cwd.
const storageStatePath = path.join(__dirname, 'storageState.json');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  // The metering specs need the web app to be running with its AI provider pointed at
  // the mock below. Start the app separately with (at least):
  //   OPENROUTER_DEFAULT_API_KEY=sk-e2e
  //   OPENROUTER_BASE_URL=http://127.0.0.1:4998/api/v1
  //   CRON_SECRET / STRIPE_WEBHOOK_SECRET / CSRF_SECRET shared with this process's env
  // See apps/e2e/README.metering.md.
  // The mock runs on Node (24 strips its types), not Bun: Bun 1.3.12, the repo's pinned runtime,
  // gives a node:http server no sign at all that a client aborted a streamed POST (no 'close' on
  // the response or the socket, writes keep succeeding), so a held stream web hung up on would
  // count as open forever and no spec could see Stop end a generation at the model.
  webServer: {
    command: 'node support/mock-server-main.ts',
    url: `http://127.0.0.1:${mockPort}/__health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: storageStatePath,
      },
    },
  ],
});
