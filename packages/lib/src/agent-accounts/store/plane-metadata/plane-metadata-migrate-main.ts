/**
 * The plane metadata migration one-shot (slice 1, deploy):
 * `bun run --filter @pagespace/lib credential-plane:migrate`.
 *
 * Reads PLANE_METADATA_DATABASE_URL_MIGRATE (the OWNER credential in deploys —
 * the plane's runtime user cannot run DDL), else PLANE_METADATA_DATABASE_URL
 * (local dev, CI), applies what is pending, prints the
 * file names it applied, and exits non-zero on any refusal or error. Never
 * prints the URL or any value.
 */
import { Pool } from 'pg';
import { selectPlaneMigrationUrl } from './plan-plane-migrations';
import { migratePlaneMetadata, readPlaneMigrationSources } from './plane-metadata-migrate';

const url = selectPlaneMigrationUrl({
  PLANE_METADATA_DATABASE_URL_MIGRATE: process.env.PLANE_METADATA_DATABASE_URL_MIGRATE,
  PLANE_METADATA_DATABASE_URL: process.env.PLANE_METADATA_DATABASE_URL,
});
if (url === null) {
  process.stderr.write('credential-plane:migrate: refusing to start; missing: PLANE_METADATA_DATABASE_URL_MIGRATE or PLANE_METADATA_DATABASE_URL\n');
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
