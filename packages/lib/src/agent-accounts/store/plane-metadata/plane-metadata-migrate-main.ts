/**
 * The plane metadata migration one-shot (slice 1, deploy):
 * `bun run --filter @pagespace/lib credential-plane:migrate`.
 *
 * Reads PLANE_METADATA_DATABASE_URL (the OWNER credential in deploys — the
 * plane's runtime user cannot run DDL), applies what is pending, prints the
 * file names it applied, and exits non-zero on any refusal or error. Never
 * prints the URL or any value.
 */
import { Pool } from 'pg';
import { migratePlaneMetadata, readPlaneMigrationSources } from './plane-metadata-migrate';

const url = process.env.PLANE_METADATA_DATABASE_URL?.trim() ?? '';
if (url.length === 0) {
  process.stderr.write('credential-plane:migrate: refusing to start; missing: PLANE_METADATA_DATABASE_URL\n');
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });
migratePlaneMetadata({ pool, sources: readPlaneMigrationSources() })
  .then((result) => {
    if (!result.ok) {
      process.stderr.write(`credential-plane:migrate: refused (${result.reason}${result.name === null ? '' : `: ${result.name}`})\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      result.applied.length === 0 ? 'credential-plane:migrate: up to date\n' : `credential-plane:migrate: applied ${result.applied.join(', ')}\n`,
    );
  })
  .catch((error: unknown) => {
    process.stderr.write(`credential-plane:migrate: failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
