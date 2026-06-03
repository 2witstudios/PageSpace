import 'dotenv/config';
import { createMockOpenRouter } from './mock-openrouter';

/**
 * Standalone entry point for the mock OpenRouter server, started by Playwright's
 * `webServer` config so its lifecycle is managed for the whole run. The web app must
 * be launched with OPENROUTER_BASE_URL=http://127.0.0.1:<port>/api/v1 so its AI calls
 * land here. Port is fixed (default 4998) so the app can be configured before the
 * Playwright run starts.
 */
const port = Number(process.env.E2E_MOCK_OPENROUTER_PORT ?? 4998);
const server = createMockOpenRouter();
server.listen(port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-openrouter] listening on http://127.0.0.1:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
