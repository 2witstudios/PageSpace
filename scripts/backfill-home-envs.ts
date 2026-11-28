import 'dotenv/config';
import { describeError, exitCodeFor, parseArgs as parseBackfillArgs, type CliArgs } from './lib/backfill-cli';
import type { EnsureHomeDriveEnvResult } from '@pagespace/lib/services/drive-envs/drive-envs';
import type { DriveEnvRecord } from '@pagespace/lib/services/drive-envs/drive-envs-store';

/**
 * One-shot backfill: give every existing Home drive its "Home" env.
 *
 * Correctness does not depend on this. The Home env is created LAZILY, the
 * first time the owner's Global Assistant or Imago needs a sandbox
 * (`ensureHomeEnvForOwner` in the web runtime), so a user who never runs this
 * still gets one the moment it matters. What the backfill buys is visibility:
 * Home appears in every user's env list up front, as the default the spawn
 * picker preselects, instead of materialising on first use.
 *
 * For every drive with `kind = 'HOME'` it calls `ensureHomeDriveEnv` — the
 * SAME service the lazy path calls, with the real store and the real org
 * policy reader — so:
 *
 *  - it is idempotent by construction (the store returns an existing Home env,
 *    adopts an unflagged env already named "Home", and mints otherwise, under a
 *    per-drive advisory lock with the partial unique index as the backstop), so
 *    a re-run, or a run racing a user's first tool call, ends with one Home env
 *    per drive;
 *  - it is NOT metered by the env cap or the tier, exactly like the lazy path;
 *  - it is refused where the drive's org turns persistent environments off —
 *    counted, never forced.
 *
 * No Sprite is provisioned: an env row costs nothing until a session runs in it.
 *
 * Batched with keyset pagination on the drive id, each batch bounded by
 * `--batch-size`, with one bounded read per batch to learn which drives
 * already have Home (those are counted and skipped, not re-ensured). A drive
 * whose ensure throws is counted and the walk continues; any such failure
 * makes the exit code 1, after the summary. Output names drives and owners by
 * id only, and an error by its class / SQLSTATE / constraint — never message
 * text, which can carry row values.
 *
 * Usage:
 *   bun scripts/backfill-home-envs.ts --dry-run
 *   bun scripts/backfill-home-envs.ts [--batch-size 100] [--limit N]
 */

const DEFAULT_BATCH_SIZE = 100;

export interface HomeDriveRow {
  driveId: string;
  ownerId: string;
}

/** `ensureHomeDriveEnv`'s result, narrowed to the env facts used (type-only imports, so no DB graph loads). */
export type EnsureHomeOutcome =
  | { ok: true; env: Pick<DriveEnvRecord, 'id' | 'createdAt'> }
  | Extract<EnsureHomeDriveEnvResult, { ok: false }>;

export interface BackfillHomeEnvsDeps {
  /** HOME drives with id > `afterId`, ascending by id, at most `limit` of them. */
  listHomeDrives: (input: { afterId: string; limit: number }) => Promise<HomeDriveRow[]>;
  /** Which of these drives already have a Home env (one bounded read per batch). */
  drivesWithHomeEnv: (driveIds: readonly string[]) => Promise<Set<string>>;
  ensureHome: (input: { homeDriveId: string; ownerId: string }) => Promise<EnsureHomeOutcome>;
  now: () => Date;
  log: (line: string) => void;
}

export interface BackfillHomeEnvsSummary {
  dryRun: boolean;
  /** HOME drives visited. */
  scanned: number;
  /** Already had a Home env when scanned — nothing done. */
  alreadyHadHome: number;
  /** Dry run only: drives that would be ensured. */
  wouldEnsure: number;
  /** Home env minted by this run. */
  created: number;
  /** An unflagged env already named "Home" was flagged as Home (it predates this run). */
  adopted: number;
  /** The drive's org turns persistent environments off — refused, nothing written. */
  orgPolicyRefused: number;
  failed: number;
  failedDriveIds: string[];
}

export async function runBackfillHomeEnvs({
  deps,
  dryRun = false,
  batchSize = DEFAULT_BATCH_SIZE,
  limit,
}: {
  deps: BackfillHomeEnvsDeps;
  dryRun?: boolean;
  batchSize?: number;
  /** Stop after this many drives; unset = every HOME drive. */
  limit?: number;
}): Promise<BackfillHomeEnvsSummary> {
  const summary: BackfillHomeEnvsSummary = {
    dryRun,
    scanned: 0,
    alreadyHadHome: 0,
    wouldEnsure: 0,
    created: 0,
    adopted: 0,
    orgPolicyRefused: 0,
    failed: 0,
    failedDriveIds: [],
  };
  // A minted env's `createdAt` is the ensure's `now`, which is never earlier
  // than this; an adopted one keeps the createdAt it had before the run.
  const runStartedAt = deps.now().getTime();

  deps.log(
    `${dryRun ? '[DRY RUN] ' : ''}Backfilling Home envs for HOME drives, batch size ${batchSize}` +
      `${limit === undefined ? '' : `, limit ${limit}`}\n`,
  );

  let cursor = '';
  for (;;) {
    const remaining = limit === undefined ? batchSize : Math.min(batchSize, limit - summary.scanned);
    if (remaining <= 0) break;
    const batch = await deps.listHomeDrives({ afterId: cursor, limit: remaining });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].driveId;

    const haveHome = await deps.drivesWithHomeEnv(batch.map((row) => row.driveId));
    for (const row of batch) {
      summary.scanned++;
      const label = `drive ${row.driveId} (owner ${row.ownerId})`;
      if (haveHome.has(row.driveId)) {
        summary.alreadyHadHome++;
        continue;
      }
      if (dryRun) {
        summary.wouldEnsure++;
        deps.log(`  ${label}: would ensure a Home env`);
        continue;
      }
      try {
        const result = await deps.ensureHome({ homeDriveId: row.driveId, ownerId: row.ownerId });
        if (!result.ok) {
          summary.orgPolicyRefused++;
          deps.log(`  ${label}: refused — the org turns persistent environments off`);
          continue;
        }
        if (result.env.createdAt.getTime() < runStartedAt) {
          summary.adopted++;
          deps.log(`  ${label}: adopted existing env ${result.env.id} as Home`);
        } else {
          summary.created++;
          deps.log(`  ${label}: created Home env ${result.env.id}`);
        }
      } catch (error) {
        summary.failed++;
        summary.failedDriveIds.push(row.driveId);
        deps.log(`  ${label}: FAILED — ${describeError(error)}`);
      }
    }
    deps.log(`  …${summary.scanned} drive(s) scanned`);
  }

  printSummary(summary, deps.log);
  return summary;
}

function printSummary(summary: BackfillHomeEnvsSummary, log: (line: string) => void): void {
  const lines = [
    `\nDone${summary.dryRun ? ' (dry run — nothing written)' : ''}.`,
    `  HOME drives scanned:           ${summary.scanned}`,
    `  already had a Home env:        ${summary.alreadyHadHome}`,
  ];
  if (summary.dryRun) {
    lines.push(`  would ensure a Home env:       ${summary.wouldEnsure}`);
  } else {
    lines.push(
      `  Home envs created:             ${summary.created}`,
      `  existing "Home" envs adopted:  ${summary.adopted}`,
      `  refused by org policy:         ${summary.orgPolicyRefused}`,
      `  failed:                        ${summary.failed}`,
    );
    if (summary.failed > 0) lines.push(`  failed drive ids: ${summary.failedDriveIds.join(', ')}`);
  }
  log(lines.join('\n'));
}

// The CLI lives in `lib/backfill-cli.ts`; re-exported for this script's tests.
export { exitCodeFor };
export type { CliArgs };
export function parseArgs(argv: readonly string[]): CliArgs {
  return parseBackfillArgs(argv, DEFAULT_BATCH_SIZE);
}

/**
 * The production wiring: the real `drive_envs` store, the real org-policy
 * reader (the one the web tier's `createDriveEnv` deps use), and the same
 * `ensureHomeDriveEnv` the lazy path calls. Imported lazily so the unit test
 * of the runner never loads the database module graph.
 */
export async function buildRealDeps(): Promise<BackfillHomeEnvsDeps> {
  const [
    { db },
    { and, asc, eq, gt, inArray },
    { drives },
    { driveEnvs },
    { createDbDriveEnvStore },
    { ensureHomeDriveEnv },
    { getDrivePolicies },
  ] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/core'),
    import('@pagespace/db/schema/drive-envs'),
    import('@pagespace/lib/services/drive-envs/drive-envs-store'),
    import('@pagespace/lib/services/drive-envs/drive-envs'),
    import('@pagespace/lib/organizations/policy-reader'),
  ]);
  const store = await createDbDriveEnvStore();
  const now = () => new Date();
  return {
    listHomeDrives: async ({ afterId, limit }) =>
      db
        .select({ driveId: drives.id, ownerId: drives.ownerId })
        .from(drives)
        .where(and(eq(drives.kind, 'HOME'), gt(drives.id, afterId)))
        .orderBy(asc(drives.id))
        .limit(limit),
    drivesWithHomeEnv: async (driveIds) => {
      if (driveIds.length === 0) return new Set();
      const rows = await db
        .select({ driveId: driveEnvs.driveId })
        .from(driveEnvs)
        .where(and(inArray(driveEnvs.driveId, [...driveIds]), eq(driveEnvs.isHome, true)))
        // At most one Home per drive (partial unique index), so the batch bounds it.
        .limit(driveIds.length);
      return new Set(rows.map((row) => row.driveId));
    },
    ensureHome: ({ homeDriveId, ownerId }) =>
      ensureHomeDriveEnv({
        homeDriveId,
        ownerId,
        deps: {
          store,
          getDriveOrgPolicies: async (driveId) => (await getDrivePolicies(driveId))?.policies ?? null,
          now,
        },
      }),
    now,
    log: (line) => console.log(line),
  };
}

// Only run when invoked directly (not when imported by tests). `main` is
// bun's; @types/node, which scripts/tsconfig.json typechecks against, lacks it.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  Promise.resolve()
    .then(async () => {
      const args = parseArgs(process.argv.slice(2));
      return runBackfillHomeEnvs({ deps: await buildRealDeps(), ...args });
    })
    .then((summary) => process.exit(exitCodeFor(summary)))
    .catch((error) => {
      console.error(`Backfill failed: ${describeError(error)}`);
      process.exit(1);
    });
}
