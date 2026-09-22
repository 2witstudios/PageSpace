/**
 * The credential plane process entry (L2·G2): parse the environment, refuse
 * to start half-configured (naming variables, never values), then serve.
 * `bun run --filter @pagespace/lib credential-plane`.
 */
import { parsePlaneEnv } from './parse-plane-env';
import { startCredentialPlane } from './plane-worker';

const verdict = parsePlaneEnv({ env: process.env });
if (!verdict.ok) {
  process.stderr.write(`credential-plane: refusing to start; missing: ${verdict.missing.join(', ') || 'none'}; malformed: ${verdict.malformed.join(', ') || 'none'}\n`);
  process.exit(1);
}
startCredentialPlane({ config: verdict.config }).then(
  () => process.stdout.write(`credential-plane: listening on :${verdict.config.port}\n`),
  (error: unknown) => {
    process.stderr.write(`credential-plane: failed to start: ${error instanceof Error ? error.name : 'unknown'}\n`);
    process.exit(1);
  },
);
