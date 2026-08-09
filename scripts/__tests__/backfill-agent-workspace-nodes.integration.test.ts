/**
 * THE BACKFILL'S I/O SHELL, against a real Postgres.
 *
 * `workspace-node-backfill.ts` is a pure function over rows and is tested
 * without a database. What is left in `scripts/backfill-agent-workspace-nodes.ts`
 * — which workspaces the scan visits, which it decides it has ALREADY done, and
 * what it writes for the ones it has not — is not pure and had no coverage at
 * all, which is how the question this file exists to pin got asked wrong.
 *
 * **The question is "has the backfill run against this workspace", and it has to
 * be MONOTONIC.** The runtime guard (`awaitsBackfill`) already learned that the
 * hard way: it used to ask "is there a legacy row with no node", which flips
 * back to true the moment a tree is legitimately emptied, and bricked correctly
 * migrated workspaces. Its answer is `agent_workspace_node_revs` — written by
 * the backfill in the same transaction as the nodes, only ever incremented, and
 * never deleted (`destroy` removes the nodes and leaves the rev standing).
 *
 * `loadAlreadyMigrated` was asking the OTHER question — "does this workspace
 * hold node rows?" — which is the same non-monotonic mistake on the other side
 * of the same cutover, and it matters because the census this script prints is
 * the documented gate on the destructive follow-up migration, and that census
 * is read while the app is live.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied, like every other
 * DB-backed test in this directory.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, runMigrations, truncateAll, closePool, type TestDb } from './setup';
import { backfill } from '../backfill-agent-workspace-nodes';

/**
 * The script's own db handle type. Taken from the function rather than imported,
 * because the type it wants is `typeof getMigrationDb()` — the unthrottled
 * migration pool — which the db package does not export by name.
 */
type BackfillDb = Parameters<typeof backfill>[1];

let db: TestDb;

const USER_ID = 'bf_user_001';

beforeAll(async () => {
  db = createTestDb();
  await runMigrations(db);
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(sql`
    INSERT INTO "users" ("id","name","email","emailBidx","provider","createdAt","updatedAt")
    VALUES (${USER_ID}, 'Backfill Tester', 'backfill@test.local', 'bidx_backfill_test_local', 'email', now(), now())
  `);
});

/** A workspace as it exists BEFORE the cutover: membership in the old columns only. */
async function legacyWorkspace(id: string): Promise<string> {
  await db.execute(sql`
    INSERT INTO "agent_workspaces" ("id","ownerId","name","createdAt","updatedAt")
    VALUES (${id}, ${USER_ID}, 'legacy', now(), now())
  `);
  const conversationId = `${id}_conv`;
  await db.execute(sql`
    INSERT INTO "conversations" ("id","userId","type","workspaceId","isActive","createdAt","updatedAt")
    VALUES (${conversationId}, ${USER_ID}, 'global', ${id}, true, now(), now())
  `);
  return conversationId;
}

async function nodeCount(workspaceId: string): Promise<number> {
  const result = await db.execute(
    sql`SELECT count(*)::int AS n FROM "agent_workspace_nodes" WHERE "rootId" = ${workspaceId}`,
  );
  const rows = (Array.isArray(result) ? result : result.rows) as { n: number }[];
  return rows[0].n;
}

/**
 * What `endSession` leaves behind: every node gone, the rev row standing and
 * bumped. Spelled out rather than driven through the runtime because that lives
 * in `apps/web` and this suite is the script's, but it is the same two
 * statements `writeWorkspaceNodes` issues for a drop-everything write.
 */
async function emptyTheTree(workspaceId: string): Promise<void> {
  await db.execute(sql`DELETE FROM "agent_workspace_nodes" WHERE "rootId" = ${workspaceId}`);
  await db.execute(
    sql`UPDATE "agent_workspace_node_revs" SET "rev" = "rev" + 1 WHERE "rootId" = ${workspaceId}`,
  );
}

const run = (options: { dryRun: boolean }) =>
  backfill({ ...options, quiet: true }, db as unknown as BackfillDb);

describe('a second run over a workspace the first run already migrated', () => {
  it('skips it, and skips it by the REV ROW so an emptied tree is not re-derived', async () => {
    // The failure this pins, end to end:
    //
    //  1. the backfill migrates a pre-cutover workspace — nodes + rev 0;
    //  2. the app goes live and the session is ended, which destroys the tree
    //     and leaves the workspace at zero nodes (a legitimate, ordinary state);
    //  3. the operator re-runs the census before the destructive migration,
    //     exactly as the procedure at the top of the script instructs.
    //
    // Keyed on nodes, step 3 finds none, calls the workspace unmigrated, and
    // re-derives it from the legacy rows — which are still there, because
    // NOTHING writes `conversations.workspaceId` or `closedInWorkspaceAt` any
    // more, so no node-model action can ever retire them. A dry run reports a
    // workspace it has already done as outstanding; `--apply` resurrects the
    // tree the user ended, and does it WITHOUT bumping the rev (the rev insert
    // is `onConflictDoNothing`), so no live client ever learns the rows are
    // back and the next write computes against a base it cannot see.
    const workspaceId = 'ws_emptied_001';
    await legacyWorkspace(workspaceId);

    const first = await run({ dryRun: false });
    expect(first.written).toBe(1);
    expect(await nodeCount(workspaceId)).toBeGreaterThan(0);

    await emptyTheTree(workspaceId);

    const census = await run({ dryRun: true });
    expect(census.alreadyMigrated).toBe(1);
    expect(census.written).toBe(0);

    const second = await run({ dryRun: false });
    expect(second.alreadyMigrated).toBe(1);
    expect(second.written).toBe(0);
    expect(await nodeCount(workspaceId)).toBe(0);
  });

  it('still migrates a workspace that has neither nodes NOR a rev row', async () => {
    // The other side of the same predicate: keying on the rev row must not turn
    // the skip into a blanket one. A workspace the first run never reached has
    // no rev row, and the second run must do it.
    const workspaceId = 'ws_untouched_001';
    await legacyWorkspace(workspaceId);

    const totals = await run({ dryRun: false });
    expect(totals.written).toBe(1);
    expect(totals.alreadyMigrated).toBe(0);
    expect(await nodeCount(workspaceId)).toBeGreaterThan(0);
  });

  it('is idempotent on the ordinary path — a re-run over an intact tree writes nothing', async () => {
    const workspaceId = 'ws_intact_001';
    await legacyWorkspace(workspaceId);

    await run({ dryRun: false });
    const before = await nodeCount(workspaceId);

    const second = await run({ dryRun: false });
    expect(second.alreadyMigrated).toBe(1);
    expect(second.written).toBe(0);
    expect(await nodeCount(workspaceId)).toBe(before);
  });
});
