import 'dotenv/config';
import { getMigrationDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { and, asc, eq, gt, isNull, lt, or, sql } from '@pagespace/db/operators';
import { BUILTIN_AGENT_KEYS, RETIRED_BUILTIN_AGENT_KEYS } from '@pagespace/lib/agents/builtin-agents';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { provisionHomeDriveIfNeeded } from '@pagespace/lib/onboarding/home-drive';

/**
 * One-shot backfill: give every existing user a Home drive and the Imago
 * agent (IMG-4.3; run in production by IMG-4.4), and bring every existing
 * user's Imago to the model of IMG-10.10.
 *
 * New and returning users get both from `provisionHomeDriveIfNeeded` at sign-in,
 * but a user who never signs in again would never pass through it. For each
 * user still missing something this script:
 *
 *   1. provisions a missing Home drive through `provisionHomeDriveIfNeeded` —
 *      the same path sign-in takes, so the drive gets its publish subdomain,
 *      starter skills and Memory pages exactly as a signing-in user's would
 *      (a user who owns no drive at all also gets the "Getting Started"
 *      folder, as a first sign-in would);
 *   2. then provisions the agent through `provisionImagoAgents`, which
 *      recreates an agent page that was deleted or trashed and, in the same
 *      transaction, switches the live page to the user's reach
 *      (`userScopedAccess`), trashes the retired Planner and Researcher pages
 *      and drops their pointers, and removes the drive grants the earlier
 *      model made for any of the user's Imago pages.
 *
 * Safe to re-run: the work list is re-derived from the database on every run
 * (no Home drive, fewer live agent pages than the registry defines, or
 * IMG-10.10 cleanup still to do — see `needsCleanup`), and
 * both provisioners are idempotent. Safe to run beside live sign-ins: both
 * provisioners take the same `FOR UPDATE` lock on the user row that sign-in
 * takes, and the partial unique index on a user's Home drive and the unique
 * (userId, key) pointer index are the backstops. Nothing is deleted but the
 * retired pointers and the moot grant rows; retired pages go to the trash.
 *
 * Output names users by id only — never an email or name — and a failure
 * prints only the error's class, SQLSTATE and constraint/table names, never
 * message text or SQL parameters, which can carry row values. Any failure
 * makes the exit code 1, after the summary.
 *
 * Usage:
 *   bun scripts/backfill-imago-agents.ts --dry-run
 *   bun scripts/backfill-imago-agents.ts [--batch-size 100] [--limit N]
 */

const DEFAULT_BATCH_SIZE = 100;
const AGENT_COUNT = BUILTIN_AGENT_KEYS.length;

type MigrationDb = ReturnType<typeof getMigrationDb>;

export interface BackfillOptions {
  dryRun?: boolean;
  /** Users read and provisioned per batch. */
  batchSize?: number;
  /** Stop after this many users needing work; unset = every user. */
  limit?: number;
  /** Seam for the failure-isolation test; defaults to `provisionImagoAgents`. */
  provisionAgents?: (userId: string, client: MigrationDb) => Promise<ProvisionedAgents>;
}

/** What the backfill reads from a provisioning call. */
export interface ProvisionedAgents {
  created: readonly string[];
  retiredPageIds?: readonly string[];
  reconciledPageIds?: readonly string[];
  removedGrants?: number;
}

export interface BackfillSummary {
  dryRun: boolean;
  /** Users found needing work (no Home drive, or a missing agent). */
  scanned: number;
  /** Of those, users with no Home drive when scanned. */
  missingHome: number;
  /**
   * Of `missingHome`, users who own no drive at all. `provisionHomeDriveIfNeeded`
   * gives them the first-sign-in seed ("Getting Started" folder, tutorial task
   * lists and chats); the others get an empty Home.
   */
  missingHomeOwnsNoDrive: number;
  /** Of those, users missing at least one agent (every user without Home is). */
  missingAgents: number;
  /** Agent pages missing across the scanned users. */
  agentPagesMissing: number;
  /**
   * Users whose missing Home drive this run provisioned. A sign-in racing the
   * run for the same user may have created it first; either way it now exists.
   */
  homeDrivesProvisioned: number;
  /** Users this run provisioned without error. */
  usersProvisioned: number;
  /** Agent pages created for the provisioned users (same racing-sign-in caveat). */
  agentPagesCreated: number;
  /** Retired Planner/Researcher pages trashed (with the pages under them). */
  retiredPagesTrashed: number;
  /** Live Imago pages switched to the user's reach. */
  agentPagesReconciled: number;
  /** Drive grant rows of Imago pages removed. */
  grantsRemoved: number;
  failed: number;
  failedUserIds: string[];
  /** After a real run: users still without a Home drive (null on a dry run). */
  remainingMissingHome: number | null;
  /** After a real run: users still missing an agent or cleanup (null on a dry run). */
  remainingMissingAgents: number | null;
}

/**
 * Live agent pages for the user: pointers whose page still exists and is not
 * trashed — the same test `provisionImagoAgentsInTransaction` uses to decide
 * what to recreate. Columns are qualified by hand: drizzle drops the table
 * name from interpolated columns in a single-table select, which would make
 * `id` ambiguous inside this subquery.
 */
const liveAgentCount = sql<number>`(
  SELECT count(*)::int FROM "user_builtin_agents" uba
  INNER JOIN "pages" p ON p."id" = uba."pageId" AND p."isTrashed" = false
  WHERE uba."userId" = "users"."id"
    AND uba."key" IN (${sql.join(BUILTIN_AGENT_KEYS.map((key) => sql`${key}`), sql`, `)})
)`;

/** Whether the user owns any drive (qualified by hand, as above). */
const ownsAnyDrive = sql<boolean>`EXISTS (SELECT 1 FROM "drives" od WHERE od."ownerId" = "users"."id")`;

async function liveAgentsOf(db: MigrationDb, userId: string): Promise<number> {
  const [row] = await db.select({ live: liveAgentCount }).from(users).where(eq(users.id, userId));
  return Number(row?.live ?? 0);
}

/**
 * IMG-10.10 cleanup still to do for the user: a retired agent's pointer, a
 * live agent page not yet acting with the user's reach, or a drive grant of
 * any page one of their pointers names (qualified by hand, as above).
 */
const needsCleanup = sql<boolean>`EXISTS (
  SELECT 1 FROM "user_builtin_agents" cu
  INNER JOIN "pages" cp ON cp."id" = cu."pageId"
  WHERE cu."userId" = "users"."id"
    AND (
      cu."key" IN (${sql.join(RETIRED_BUILTIN_AGENT_KEYS.map((key) => sql`${key}`), sql`, `)})
      OR (cp."isTrashed" = false AND cp."userScopedAccess" = false)
      OR EXISTS (
        SELECT 1 FROM "drive_agent_members" cm
        WHERE cm."agentPageId" = cu."pageId" AND cm."driveId" <> cp."driveId"
      )
    )
)`;

const needsWork = or(isNull(drives.id), lt(liveAgentCount, AGENT_COUNT), needsCleanup);

const homeJoin = and(eq(drives.ownerId, users.id), eq(drives.kind, 'HOME'));

export async function runBackfill({
  dryRun = false,
  batchSize = DEFAULT_BATCH_SIZE,
  limit,
  provisionAgents = provisionImagoAgents,
}: BackfillOptions = {}): Promise<BackfillSummary> {
  const db = getMigrationDb();
  const summary: BackfillSummary = {
    dryRun,
    scanned: 0,
    missingHome: 0,
    missingHomeOwnsNoDrive: 0,
    missingAgents: 0,
    agentPagesMissing: 0,
    homeDrivesProvisioned: 0,
    usersProvisioned: 0,
    agentPagesCreated: 0,
    retiredPagesTrashed: 0,
    agentPagesReconciled: 0,
    grantsRemoved: 0,
    failed: 0,
    failedUserIds: [],
    remainingMissingHome: null,
    remainingMissingAgents: null,
  };

  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}Backfilling Home drives and Imago agents ` +
      `(${BUILTIN_AGENT_KEYS.join(', ')}), batch size ${batchSize}` +
      `${limit === undefined ? '' : `, limit ${limit}`}\n`,
  );

  // Keyset pagination on the user id: the loop shrinks the very predicate it
  // filters on, so an OFFSET walk would skip users.
  let cursor = '';
  for (;;) {
    const remaining = limit === undefined ? batchSize : Math.min(batchSize, limit - summary.scanned);
    if (remaining <= 0) break;

    const batch = await db
      .select({
        userId: users.id,
        homeDriveId: drives.id,
        liveAgents: liveAgentCount,
        ownsAnyDrive,
      })
      .from(users)
      .leftJoin(drives, homeJoin)
      .where(and(gt(users.id, cursor), needsWork))
      .orderBy(asc(users.id))
      .limit(remaining);

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].userId;

    for (const row of batch) {
      summary.scanned++;
      const hasHome = row.homeDriveId !== null;
      const missing = hasHome ? AGENT_COUNT - Number(row.liveAgents) : AGENT_COUNT;
      if (!hasHome) summary.missingHome++;
      if (!hasHome && !row.ownsAnyDrive) summary.missingHomeOwnsNoDrive++;
      if (missing > 0) summary.missingAgents++;
      summary.agentPagesMissing += missing;

      const homeGap = hasHome ? '' : row.ownsAnyDrive ? 'no Home drive, ' : 'owns no drive, ';
      const gap = `${homeGap}${missing} agent(s) missing${missing === 0 ? ', cleanup due' : ''}`;
      if (dryRun) {
        console.log(`  user ${row.userId}: would provision (${gap})`);
        continue;
      }

      try {
        let createdPages = 0;
        if (!hasHome) {
          // The Home step provisions the agents itself, after its own commit;
          // the user had none when scanned, so whatever is live now came from
          // that step. It only logs an agent failure (Home must not depend on
          // the agents), so the provisioner call below is what reports it.
          await provisionHomeDriveIfNeeded(row.userId);
          summary.homeDrivesProvisioned++;
          createdPages += await liveAgentsOf(db, row.userId);
        }
        const provisioned = await provisionAgents(row.userId, db);
        createdPages += provisioned.created.length;
        const retired = provisioned.retiredPageIds?.length ?? 0;
        const reconciled = provisioned.reconciledPageIds?.length ?? 0;
        const grants = provisioned.removedGrants ?? 0;
        summary.agentPagesCreated += createdPages;
        summary.retiredPagesTrashed += retired;
        summary.agentPagesReconciled += reconciled;
        summary.grantsRemoved += grants;
        summary.usersProvisioned++;
        console.log(
          `  user ${row.userId}: provisioned (${gap}; created ${createdPages} agent page(s), ` +
            `trashed ${retired} retired page(s), reconciled ${reconciled}, removed ${grants} grant(s))`,
        );
      } catch (error) {
        summary.failed++;
        summary.failedUserIds.push(row.userId);
        console.error(`  user ${row.userId}: FAILED — ${describeError(error)}`);
      }
    }

    console.log(`  …${summary.scanned} user(s) scanned`);
  }

  if (!dryRun) {
    const [counts] = await db
      .select({
        missingHome: sql<number>`count(*) FILTER (WHERE ${drives.id} IS NULL)::int`,
        missingAgents: sql<number>`count(*)::int`,
      })
      .from(users)
      .leftJoin(drives, homeJoin)
      .where(needsWork);
    summary.remainingMissingHome = Number(counts?.missingHome ?? 0);
    summary.remainingMissingAgents = Number(counts?.missingAgents ?? 0);
  }

  printSummary(summary);
  return summary;
}

function printSummary(summary: BackfillSummary): void {
  const lines = [
    `\nDone${summary.dryRun ? ' (dry run — nothing written)' : ''}.`,
    `  users needing work:            ${summary.scanned}`,
    `  missing a Home drive:          ${summary.missingHome}`,
    `    of which own no drive (get "Getting Started"): ${summary.missingHomeOwnsNoDrive}`,
    `  missing at least one agent:    ${summary.missingAgents}`,
    `  agent pages missing:           ${summary.agentPagesMissing}`,
  ];
  if (!summary.dryRun) {
    lines.push(
      `  Home drives provisioned:       ${summary.homeDrivesProvisioned}`,
      `  users provisioned:             ${summary.usersProvisioned}`,
      `  agent pages created:           ${summary.agentPagesCreated}`,
      `  retired pages trashed:         ${summary.retiredPagesTrashed}`,
      `  agent pages reconciled:        ${summary.agentPagesReconciled}`,
      `  grant rows removed:            ${summary.grantsRemoved}`,
      `  failed:                        ${summary.failed}`,
      `  still missing a Home drive:    ${summary.remainingMissingHome}`,
      `  still missing an agent:        ${summary.remainingMissingAgents}`,
    );
    if (summary.failed > 0) lines.push(`  failed user ids: ${summary.failedUserIds.join(', ')}`);
  }
  console.log(lines.join('\n'));
}

/**
 * Names the failure without any text that could carry a row value: Postgres
 * puts values in some messages (22P02: `invalid input syntax for type
 * integer: "<value>"`) and drizzle appends the query's params to its own. So
 * this prints only the error's class, the driver's SQLSTATE and, when the
 * driver reports them, the constraint and table names — schema identifiers,
 * never data. Re-run for the user id it is printed beside to see more.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  for (let current: unknown = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    const detail = current as Error & { code?: unknown; constraint?: unknown; table?: unknown };
    parts.push(current.constructor.name || 'Error');
    if (typeof detail.code === 'string' && /^[0-9A-Z]{5}$/.test(detail.code)) parts.push(`SQLSTATE ${detail.code}`);
    if (typeof detail.constraint === 'string') parts.push(`constraint ${detail.constraint}`);
    if (typeof detail.table === 'string') parts.push(`table ${detail.table}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'non-Error value thrown';
}

export function exitCodeFor(summary: Pick<BackfillSummary, 'failed'>): number {
  return summary.failed > 0 ? 1 : 0;
}

export interface CliArgs {
  dryRun: boolean;
  batchSize: number;
  limit: number | undefined;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { dryRun: false, batchSize: DEFAULT_BATCH_SIZE, limit: undefined };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    const value = () => {
      const raw = inline ?? argv[++i];
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        throw new Error(`${flag} needs a positive integer`);
      }
      return Number(raw);
    };
    if (flag === '--dry-run' && inline === undefined) args.dryRun = true;
    else if (flag === '--batch-size') args.batchSize = value();
    else if (flag === '--limit') args.limit = value();
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

// Only run when invoked directly (not when imported by tests). `main` is
// bun's; @types/node, which scripts/tsconfig.json typechecks against, lacks it.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  Promise.resolve()
    .then(() => runBackfill(parseArgs(process.argv.slice(2))))
    .then((summary) => process.exit(exitCodeFor(summary)))
    .catch((error) => {
      console.error(`Backfill failed: ${describeError(error)}`);
      process.exit(1);
    });
}
