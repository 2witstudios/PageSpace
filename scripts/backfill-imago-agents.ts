import 'dotenv/config';
import { getMigrationDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { and, asc, eq, gt, isNull, lt, or, sql } from '@pagespace/db/operators';
import { BUILTIN_AGENT_KEYS } from '@pagespace/lib/agents/builtin-agents';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { provisionHomeDriveIfNeeded } from '@pagespace/lib/onboarding/home-drive';

/**
 * One-shot backfill: give every existing user a Home drive and the Imago
 * agents (IMG-4.3; run in production by IMG-4.4).
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
 *   2. then provisions the agents through `provisionImagoAgents`, which
 *      recreates any agent page that was deleted or trashed.
 *
 * Safe to re-run: the work list is re-derived from the database on every run
 * (no Home drive, or fewer live agent pages than the registry defines), and
 * both provisioners are idempotent. Safe to run beside live sign-ins: both
 * provisioners take the same `FOR UPDATE` lock on the user row that sign-in
 * takes, and the partial unique index on a user's Home drive and the unique
 * (userId, key) pointer index are the backstops. Nothing is ever deleted.
 *
 * Output names users by id only — never an email or name — and failures print
 * the error's first line, never SQL parameters. Any failure makes the exit
 * code 1, after the summary.
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
  provisionAgents?: (userId: string, client: MigrationDb) => Promise<{ created: readonly string[] }>;
}

export interface BackfillSummary {
  dryRun: boolean;
  /** Users found needing work (no Home drive, or a missing agent). */
  scanned: number;
  /** Of those, users with no Home drive when scanned. */
  missingHome: number;
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
  failed: number;
  failedUserIds: string[];
  /** After a real run: users still without a Home drive (null on a dry run). */
  remainingMissingHome: number | null;
  /** After a real run: users still missing an agent (null on a dry run). */
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

async function liveAgentsOf(db: MigrationDb, userId: string): Promise<number> {
  const [row] = await db.select({ live: liveAgentCount }).from(users).where(eq(users.id, userId));
  return Number(row?.live ?? 0);
}

const needsWork = or(isNull(drives.id), lt(liveAgentCount, AGENT_COUNT));

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
    missingAgents: 0,
    agentPagesMissing: 0,
    homeDrivesProvisioned: 0,
    usersProvisioned: 0,
    agentPagesCreated: 0,
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
      .select({ userId: users.id, homeDriveId: drives.id, liveAgents: liveAgentCount })
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
      if (missing > 0) summary.missingAgents++;
      summary.agentPagesMissing += missing;

      const gap = `${hasHome ? '' : 'no Home drive, '}${missing} agent(s) missing`;
      if (dryRun) {
        console.log(`  user ${row.userId}: would provision (${gap})`);
        continue;
      }

      try {
        let createdPages = 0;
        if (!hasHome) {
          // The Home step provisions the agents itself (it calls the agent
          // provisioner inside its transaction); the user had none when
          // scanned, so whatever is live now came from that step.
          await provisionHomeDriveIfNeeded(row.userId);
          summary.homeDrivesProvisioned++;
          createdPages += await liveAgentsOf(db, row.userId);
        }
        const { created } = await provisionAgents(row.userId, db);
        createdPages += created.length;
        summary.agentPagesCreated += createdPages;
        summary.usersProvisioned++;
        console.log(`  user ${row.userId}: provisioned (${gap}; created ${createdPages} agent page(s))`);
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
    `  missing at least one agent:    ${summary.missingAgents}`,
    `  agent pages missing:           ${summary.agentPagesMissing}`,
  ];
  if (!summary.dryRun) {
    lines.push(
      `  Home drives provisioned:       ${summary.homeDrivesProvisioned}`,
      `  users provisioned:             ${summary.usersProvisioned}`,
      `  agent pages created:           ${summary.agentPagesCreated}`,
      `  failed:                        ${summary.failed}`,
      `  still missing a Home drive:    ${summary.remainingMissingHome}`,
      `  still missing an agent:        ${summary.remainingMissingAgents}`,
    );
    if (summary.failed > 0) lines.push(`  failed user ids: ${summary.failedUserIds.join(', ')}`);
  }
  console.log(lines.join('\n'));
}

/**
 * One line, no SQL parameters: a drizzle query error's message is
 * "Failed query: <sql>\nparams: <values>", so only the first line is kept, and
 * the driver's error (code + message, which carry no row values) is preferred
 * when there is one.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const cause = error.cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    return `${typeof code === 'string' ? `${code} ` : ''}${cause.message.split('\n')[0]}`;
  }
  return error.message.split('\n')[0];
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
