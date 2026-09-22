/**
 * The worker process entry point, as a substrate starts it:
 * `node standalone-browser-worker.js`, configured only through the
 * `BROWSER_*` environment (`parse-worker-env.ts`). It prints one JSON line,
 * `{"listening":"http://host:port"}`, once it serves, and closes the browser
 * and removes the profile on SIGTERM/SIGINT.
 */
import { parseWorkerEnv } from './parse-worker-env.js';
import { startBrowserControlWorker } from './browser-control-worker.js';

const main = async (): Promise<void> => {
  const parsed = parseWorkerEnv(process.env);
  if (!parsed.ok) {
    process.stderr.write(`browser worker refused to start: ${parsed.reason}\n`);
    process.exit(78);
  }
  const { config } = parsed;
  const worker = await startBrowserControlWorker({
    sessionId: config.sessionId,
    controlPublicKey: config.controlPublicKey,
    allowedOrigins: config.allowedOrigins,
    listen: { host: config.host, port: config.port },
    profileRoot: config.profileRoot ?? undefined,
    executablePath: config.executablePath ?? undefined,
    onExpire: () => process.exit(0),
  });
  process.stdout.write(`${JSON.stringify({ listening: worker.url })}\n`);

  const stop = (): void => {
    worker.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
};

main().catch((error: unknown) => {
  process.stderr.write(`browser worker failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
