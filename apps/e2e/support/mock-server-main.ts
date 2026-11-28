import 'dotenv/config';
import { createMockOpenRouter } from './mock-openrouter.ts';
import { createMockS3 } from './mock-s3.ts';

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

/**
 * The S3 stand-in apps/web stores page content in (mock-s3.ts), on its own port so its
 * path-style `/<bucket>/<key>` requests never meet the OpenRouter routes. Start the web app
 * with AWS_ENDPOINT_URL_S3=http://127.0.0.1:<port>. It is up before the OpenRouter health
 * check Playwright waits on can answer, since both listen from this one synchronous start.
 */
const s3Port = Number(process.env.E2E_MOCK_S3_PORT ?? 4997);
const s3 = createMockS3();
s3.listen(s3Port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-s3] listening on http://127.0.0.1:${s3Port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    s3.close();
    server.close(() => process.exit(0));
  });
}
