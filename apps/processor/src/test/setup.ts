/**
 * Vitest setup for @pagespace/processor.
 *
 * Node >= 23 removed the long-deprecated `util.isNullOrUndefined`, but
 * @tensorflow/tfjs-node 4.x (magika's backend) still calls it at classify
 * time. CI runs Node 22 so the gap only shows locally on newer Node, where
 * every magika classification throws "(0 , util_1.isNullOrUndefined) is not
 * a function" and the content-detector suites fail against a fully present
 * model. Restoring the one-line predicate before tfjs-node loads lets the
 * real model run on every Node version instead of skipping the suites.
 * Remove once tfjs-node ships a release that no longer uses the API.
 */
import util from 'util';

type UtilWithLegacyPredicate = typeof util & {
  isNullOrUndefined?: (value: unknown) => boolean;
};

const patchable = util as UtilWithLegacyPredicate;
if (typeof patchable.isNullOrUndefined !== 'function') {
  patchable.isNullOrUndefined = (value: unknown): boolean =>
    value === null || value === undefined;
}

/**
 * Restore DATABASE_URL before every test file.
 *
 * vitest.config.ts runs this package in a SINGLE fork, so `process.env` is one
 * shared object across all 67 test files. Three suites assign a placeholder
 * DATABASE_URL for their own module load (db.test.ts, server.test.ts,
 * queue-manager-full.test.ts) and the value outlives them — so any suite that
 * runs later and talks to a real Postgres inherits `postgresql://localhost:5432/test`
 * and dies with `database "test" does not exist`, depending on file order.
 *
 * Setup runs before each file's own module evaluation, so stashing the pristine
 * value on first run and restoring it here undoes the previous file's clobber
 * while still letting a suite override it for itself afterwards.
 */
const PRISTINE_DATABASE_URL = 'PAGESPACE_PRISTINE_DATABASE_URL';

if (process.env[PRISTINE_DATABASE_URL] === undefined) {
  process.env[PRISTINE_DATABASE_URL] = process.env.DATABASE_URL ?? '';
} else if (process.env[PRISTINE_DATABASE_URL] !== '') {
  process.env.DATABASE_URL = process.env[PRISTINE_DATABASE_URL];
} else {
  // Pristine was unset. Restoring '' would leave a suite's placeholder looking
  // like a configured database to every file that runs after it, so unset it.
  delete process.env.DATABASE_URL;
}
