/**
 * THE IMAGO AGENTS BACKFILL, against a real Postgres — no vi.mock.
 *
 * New and returning users get a Home drive and the Imago agents from
 * `provisionHomeDriveIfNeeded`, but a user who never signs in again would
 * never get either. This script covers them, and it is run by the owner in
 * production (IMG-4.4), so the properties pinned here are the ones an operator
 * relies on without being able to see them:
 *
 *   1. **A dry run writes nothing** and still reports who is missing what.
 *   2. **A real run fills both gaps**: a user with no Home drive gets one (via
 *      `provisionHomeDriveIfNeeded`) and then the agents; a user with Home but
 *      a missing, deleted or trashed agent gets it back.
 *   3. **A re-run is a no-op**, and so is a run racing a live sign-in for the
 *      same user — one Home drive, one live page per key.
 *   4. **One user's failure is counted, not fatal**, and the summary turns it
 *      into a non-zero exit code.
 *   5. **Nothing but ids is printed** — never an email.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied, like every other
 * DB-backed test in this directory.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { schema } from '@pagespace/db/schema';
import { BUILTIN_AGENT_KEYS } from '@pagespace/lib/agents/builtin-agents';
import { provisionImagoAgentsInTransaction } from '@pagespace/lib/agents/provision-imago-agents';
import { provisionHomeDriveIfNeeded } from '@pagespace/lib/onboarding/home-drive';
import { createTestDb, runMigrations, truncateAll, closePool, type TestDb } from './setup';
import { exitCodeFor, parseArgs, runBackfill } from '../backfill-imago-agents';

let db: TestDb;
const pools: Pool[] = [];
const AGENT_COUNT = BUILTIN_AGENT_KEYS.length;

beforeAll(async () => {
  db = createTestDb();
  await runMigrations(db);
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
  await closePool();
});

beforeEach(async () => {
  await truncateAll(db);
});

function emailOf(userId: string) {
  return `${userId}@imago-backfill.example`;
}

async function seedUser(userId: string, { home = false }: { home?: boolean } = {}) {
  await db.execute(
    sql`INSERT INTO users (id, email, name) VALUES (${userId}, ${emailOf(userId)}, ${`Name ${userId}`})`,
  );
  if (home) {
    await db.execute(
      sql`INSERT INTO drives (id, name, slug, "ownerId", kind, "updatedAt")
          VALUES (${`home_${userId}`}, 'Home', 'home', ${userId}, 'HOME', now())`,
    );
  }
}

/** A user with a second, STANDARD drive — the "existing user without Home" shape. */
async function seedStandardDrive(userId: string) {
  await db.execute(
    sql`INSERT INTO drives (id, name, slug, "ownerId", kind, "updatedAt")
        VALUES (${`std_${userId}`}, 'Work', 'work', ${userId}, 'STANDARD', now())`,
  );
}

async function homeDrivesOf(userId: string): Promise<string[]> {
  const { rows } = await db.execute(
    sql`SELECT id FROM drives WHERE "ownerId" = ${userId} AND kind = 'HOME'`,
  );
  return rows.map((row) => String(row.id));
}

/** Live (non-trashed) agent pages per key, as the pointer table records them. */
async function liveAgentsOf(userId: string): Promise<Record<string, string>> {
  const { rows } = await db.execute(sql`
    SELECT uba.key, uba."pageId", p."driveId"
    FROM user_builtin_agents uba
    JOIN pages p ON p.id = uba."pageId" AND p."isTrashed" = false
    WHERE uba."userId" = ${userId}
  `);
  return Object.fromEntries(rows.map((row) => [String(row.key), String(row.pageId)]));
}

async function aiChatPageCount(userId: string): Promise<number> {
  const { rows } = await db.execute(sql`
    SELECT count(*)::int AS n FROM pages p
    JOIN drives d ON d.id = p."driveId"
    WHERE d."ownerId" = ${userId} AND p.type = 'AI_CHAT' AND p."isTrashed" = false
  `);
  return Number(rows[0].n);
}

async function rowCounts() {
  const { rows } = await db.execute(sql`
    SELECT (SELECT count(*) FROM drives)::int AS drives,
           (SELECT count(*) FROM pages)::int AS pages,
           (SELECT count(*) FROM user_builtin_agents)::int AS pointers,
           (SELECT count(*) FROM drive_agent_members)::int AS members
  `);
  return rows[0];
}

/** Silences and captures everything the script prints. */
function captureOutput() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${String(arg.cause)}` : String(arg))).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'error').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
  ];
  return {
    text: () => lines.join('\n'),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

async function quietly<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const capture = captureOutput();
  try {
    const result = await run();
    return { result, output: capture.text() };
  } finally {
    capture.restore();
  }
}

describe('backfill-imago-agents (Postgres)', () => {
  it('given --dry-run, should report users missing a Home drive and users missing any agent without writing', async () => {
    await seedUser('bf_u_nohome');
    await seedUser('bf_u_nohome_std');
    await seedStandardDrive('bf_u_nohome_std');
    await seedUser('bf_u_home_noagents', { home: true });
    await seedUser('bf_u_complete');
    await provisionHomeDriveIfNeeded('bf_u_complete');
    const before = await rowCounts();

    const { result: summary } = await quietly(() => runBackfill({ dryRun: true }));

    expect(summary).toMatchObject({
      dryRun: true,
      scanned: 3,
      missingHome: 2,
      // bf_u_nohome owns no drive at all: provisionHomeDriveIfNeeded gives it
      // the first-sign-in "Getting Started" seed, so it is reported apart from
      // bf_u_nohome_std, which gets an empty Home.
      missingHomeOwnsNoDrive: 1,
      missingAgents: 3,
      agentPagesMissing: 3 * AGENT_COUNT,
      homeDrivesProvisioned: 0,
      usersProvisioned: 0,
      agentPagesCreated: 0,
      failed: 0,
    });
    expect(await rowCounts()).toEqual(before);
    expect(await homeDrivesOf('bf_u_nohome')).toEqual([]);
    expect(await liveAgentsOf('bf_u_home_noagents')).toEqual({});
  });

  it('given a user with no Home drive, should provision Home through provisionHomeDriveIfNeeded and then the agents', async () => {
    await seedUser('bf_u_nohome');
    await seedStandardDrive('bf_u_nohome');

    const { result: summary } = await quietly(() => runBackfill());

    const homes = await homeDrivesOf('bf_u_nohome');
    expect(homes).toHaveLength(1);
    const agents = await liveAgentsOf('bf_u_nohome');
    expect(Object.keys(agents).sort()).toEqual([...BUILTIN_AGENT_KEYS].sort());
    const { rows } = await db.execute(sql`
      SELECT DISTINCT p."driveId" FROM pages p WHERE p.id IN (${sql.join(Object.values(agents).map((id) => sql`${id}`), sql`, `)})
    `);
    expect(rows.map((row) => String(row.driveId))).toEqual(homes);
    // provisionHomeDriveIfNeeded's own seeding ran too: the user's starter
    // skills are stamped, which only that path does for a new Home drive.
    const { rows: stamp } = await db.execute(
      sql`SELECT "starterSkillsInstalledAt" FROM users WHERE id = 'bf_u_nohome'`,
    );
    expect(stamp[0].starterSkillsInstalledAt).not.toBeNull();
    // The existing STANDARD drive is untouched.
    const { rows: std } = await db.execute(sql`SELECT kind FROM drives WHERE id = 'std_bf_u_nohome'`);
    expect(std[0].kind).toBe('STANDARD');

    expect(summary).toMatchObject({
      dryRun: false,
      scanned: 1,
      missingHome: 1,
      missingHomeOwnsNoDrive: 0,
      missingAgents: 1,
      homeDrivesProvisioned: 1,
      usersProvisioned: 1,
      agentPagesCreated: AGENT_COUNT,
      failed: 0,
      remainingMissingHome: 0,
      remainingMissingAgents: 0,
    });
  });

  it('given a Home drive with a deleted agent, should provision it again', async () => {
    await seedUser('bf_u_deleted');
    await provisionHomeDriveIfNeeded('bf_u_deleted');
    const before = await liveAgentsOf('bf_u_deleted');
    await db.execute(sql`DELETE FROM pages WHERE id = ${before.imago}`);

    const { result: summary } = await quietly(() => runBackfill());

    const after = await liveAgentsOf('bf_u_deleted');
    expect(Object.keys(after)).toEqual(['imago']);
    expect(after.imago).not.toBe(before.imago);
    expect(summary).toMatchObject({ scanned: 1, missingAgents: 1, agentPagesMissing: 1, agentPagesCreated: 1, failed: 0 });
  });

  it('given a Home drive with a trashed agent, should provision a fresh one and repoint the key', async () => {
    await seedUser('bf_u_trashed');
    await provisionHomeDriveIfNeeded('bf_u_trashed');
    const before = await liveAgentsOf('bf_u_trashed');
    await db.execute(sql`UPDATE pages SET "isTrashed" = true WHERE id = ${before.imago}`);

    const { result: summary } = await quietly(() => runBackfill());

    const after = await liveAgentsOf('bf_u_trashed');
    expect(after.imago).toBeDefined();
    expect(after.imago).not.toBe(before.imago);
    expect(summary).toMatchObject({ scanned: 1, missingAgents: 1, agentPagesCreated: 1, failed: 0 });
  });

  it('given a completed run, should change nothing on a re-run', async () => {
    await seedUser('bf_u_a');
    await seedUser('bf_u_b', { home: true });
    await seedUser('bf_u_c');
    await seedStandardDrive('bf_u_c');
    await quietly(() => runBackfill());
    const afterFirst = await rowCounts();
    const agentsFirst = await Promise.all(['bf_u_a', 'bf_u_b', 'bf_u_c'].map(liveAgentsOf));

    const { result: summary } = await quietly(() => runBackfill());

    expect(summary).toMatchObject({
      scanned: 0,
      missingHome: 0,
      missingAgents: 0,
      homeDrivesProvisioned: 0,
      usersProvisioned: 0,
      agentPagesCreated: 0,
      failed: 0,
      remainingMissingHome: 0,
      remainingMissingAgents: 0,
    });
    expect(await rowCounts()).toEqual(afterFirst);
    expect(await Promise.all(['bf_u_a', 'bf_u_b', 'bf_u_c'].map(liveAgentsOf))).toEqual(agentsFirst);
    for (const userId of ['bf_u_a', 'bf_u_b', 'bf_u_c']) {
      expect(await homeDrivesOf(userId)).toHaveLength(1);
    }
    // bf_u_b and bf_u_c had a drive already, so provisioning seeded no
    // tutorial content: their only AI_CHAT pages are the agents. (bf_u_a owned
    // no drive and got the first-sign-in "Getting Started" content.)
    expect(await aiChatPageCount('bf_u_b')).toBe(AGENT_COUNT);
    expect(await aiChatPageCount('bf_u_c')).toBe(AGENT_COUNT);
  });

  it('given more users than one batch, should walk every batch and honour --limit', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `bf_u_batch_${i}`);
    for (const id of ids) await seedUser(id, { home: true });

    const { result: limited } = await quietly(() => runBackfill({ batchSize: 2, limit: 3 }));
    expect(limited).toMatchObject({ scanned: 3, usersProvisioned: 3, failed: 0, remainingMissingAgents: 4 });
    for (const id of ids.slice(0, 3)) expect(Object.keys(await liveAgentsOf(id))).toHaveLength(AGENT_COUNT);
    for (const id of ids.slice(3)) expect(await liveAgentsOf(id)).toEqual({});

    const { result: rest } = await quietly(() => runBackfill({ batchSize: 2 }));
    expect(rest).toMatchObject({ scanned: 4, usersProvisioned: 4, failed: 0, remainingMissingAgents: 0 });
    for (const id of ids) expect(Object.keys(await liveAgentsOf(id))).toHaveLength(AGENT_COUNT);
  });

  it('given a live sign-in that wins the user-row lock mid-run, should leave exactly one Home and one page per key', async () => {
    await seedUser('bf_u_race');
    await seedStandardDrive('bf_u_race');

    // The "live sign-in": a dedicated connection that takes the user-row lock
    // first, exactly as provisionHomeDriveIfNeeded does, and provisions Home
    // plus the agents while the backfill (which already scanned this user as
    // missing a Home drive) waits on that lock.
    const signInPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    pools.push(signInPool);
    const signInDb = drizzle(signInPool, { schema });

    let releaseSignIn: () => void = () => undefined;
    const signInMayCommit = new Promise<void>((resolve) => { releaseSignIn = resolve; });
    let signInLocked: () => void = () => undefined;
    const lockHeld = new Promise<void>((resolve) => { signInLocked = resolve; });

    const signIn = signInDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM users WHERE id = 'bf_u_race' FOR UPDATE`);
      signInLocked();
      await signInMayCommit;
      await tx.execute(sql`
        INSERT INTO drives (id, name, slug, "ownerId", kind, "updatedAt")
        VALUES ('home_signin_bf_u_race', 'Home', 'home', 'bf_u_race', 'HOME', now())
      `);
      await provisionImagoAgentsInTransaction(tx, 'bf_u_race', 'home_signin_bf_u_race');
    });
    await lockHeld;

    const capture = captureOutput();
    const backfill = runBackfill();
    try {
      // Contention is observed, not inferred from timing: some backend is
      // blocked on a lock behind the sign-in's FOR UPDATE.
      await waitForLockWaiter();
      releaseSignIn();
      await signIn;
      const summary = await backfill;

      expect(summary.failed).toBe(0);
      expect(await homeDrivesOf('bf_u_race')).toEqual(['home_signin_bf_u_race']);
      expect(Object.keys(await liveAgentsOf('bf_u_race')).sort()).toEqual([...BUILTIN_AGENT_KEYS].sort());
      expect(await aiChatPageCount('bf_u_race')).toBe(AGENT_COUNT);
      expect(summary).toMatchObject({ remainingMissingHome: 0, remainingMissingAgents: 0 });
    } finally {
      releaseSignIn();
      capture.restore();
    }
  });

  it('given many concurrent sign-ins during a run, should provision each user exactly once', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `bf_u_conc_${i}`);
    for (const id of ids) {
      await seedUser(id);
      await seedStandardDrive(id);
    }

    const { result } = await quietly(() => Promise.all([
      runBackfill({ batchSize: 2 }),
      ...ids.map((id) => provisionHomeDriveIfNeeded(id)),
    ]));

    expect(result[0].failed).toBe(0);
    for (const id of ids) {
      expect(await homeDrivesOf(id)).toHaveLength(1);
      expect(Object.keys(await liveAgentsOf(id))).toHaveLength(AGENT_COUNT);
      expect(await aiChatPageCount(id)).toBe(AGENT_COUNT);
    }
  });

  it('given one user failing, should finish the others, count the failure and exit non-zero', async () => {
    await seedUser('bf_u_ok_1', { home: true });
    await seedUser('bf_u_bad', { home: true });
    await seedUser('bf_u_ok_2', { home: true });

    const { result: summary, output } = await quietly(() => runBackfill({
      provisionAgents: async (userId, client) => {
        if (userId === 'bf_u_bad') throw new Error('simulated provisioning failure');
        const { provisionImagoAgents } = await import('@pagespace/lib/agents/provision-imago-agents');
        return provisionImagoAgents(userId, client);
      },
    }));

    expect(summary).toMatchObject({ scanned: 3, usersProvisioned: 2, failed: 1, remainingMissingAgents: 1 });
    expect(summary.failedUserIds).toEqual(['bf_u_bad']);
    expect(Object.keys(await liveAgentsOf('bf_u_ok_1'))).toHaveLength(AGENT_COUNT);
    expect(Object.keys(await liveAgentsOf('bf_u_ok_2'))).toHaveLength(AGENT_COUNT);
    expect(output).toContain('bf_u_bad');
    expect(exitCodeFor(summary)).toBe(1);
    expect(exitCodeFor({ failed: 0 })).toBe(0);
  });

  it('given a driver error whose message echoes a row value, should print the user id and SQLSTATE but not the value', async () => {
    await seedUser('bf_u_pgerr', { home: true });
    const secret = 'leak-me@secret.example';

    const { result: summary, output } = await quietly(() => runBackfill({
      // A REAL Postgres error, not a hand-built one: 22P02's message is
      // `invalid input syntax for type integer: "<the value>"`.
      provisionAgents: async (_userId, client) => {
        await client.execute(sql`SELECT ${secret}::int`);
        return { created: [] };
      },
    }));

    expect(summary).toMatchObject({ failed: 1, failedUserIds: ['bf_u_pgerr'] });
    expect(output).toContain('bf_u_pgerr');
    expect(output).toContain('SQLSTATE 22P02');
    expect(output).not.toContain('leak-me');
    expect(output).not.toContain('secret.example');
  });

  it('should print ids and counts but never an email', async () => {
    await seedUser('bf_u_print_1');
    await seedUser('bf_u_print_2', { home: true });

    const dry = await quietly(() => runBackfill({ dryRun: true }));
    const real = await quietly(() => runBackfill());

    for (const output of [dry.output, real.output]) {
      expect(output).toContain('bf_u_print_1');
      expect(output).not.toContain('@imago-backfill.example');
    }
    expect(dry.output).toMatch(/missing a Home drive:\s+1\n/);
    expect(dry.output).toMatch(/of which own no drive \(get "Getting Started"\):\s+1\n/);
    expect(real.output).toMatch(/still missing a Home drive:\s+0\n/);
  });
});

/**
 * A user provisioned before IMG-10.10, every agent page live: Imago acting
 * through memberships, the retired Planner and Researcher with pointers, and
 * MEMBER grants for all three in a STANDARD drive — so only the cleanup
 * predicate can put them on the work list.
 */
async function seedPre1010User(userId: string) {
  await seedUser(userId, { home: true });
  await seedStandardDrive(userId);
  await provisionHomeDriveIfNeeded(userId);
  const { imago } = await liveAgentsOf(userId);
  await db.execute(sql`UPDATE pages SET "userScopedAccess" = false WHERE id = ${imago}`);
  for (const key of ['imago-planner', 'imago-researcher']) {
    const pageId = `${key}_${userId}`;
    await db.execute(sql`
      INSERT INTO pages (id, title, type, "driveId", position, "updatedAt")
      VALUES (${pageId}, ${key}, 'AI_CHAT', ${`home_${userId}`}, 9, now())`);
    await db.execute(sql`INSERT INTO user_builtin_agents (id, "userId", key, "pageId") VALUES (${`uba_${pageId}`}, ${userId}, ${key}, ${pageId})`);
  }
  for (const pageId of [imago, `imago-planner_${userId}`, `imago-researcher_${userId}`]) {
    await db.execute(sql`
      INSERT INTO drive_agent_members (id, "driveId", "agentPageId", role, "addedBy")
      VALUES (${`dam_${pageId}`}, ${`std_${userId}`}, ${pageId}, 'MEMBER', ${userId})`);
  }
  return { imago };
}

async function cleanupStateOf(userId: string) {
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT array_agg(key ORDER BY key) FROM user_builtin_agents WHERE "userId" = ${userId}) AS keys,
      (SELECT count(*)::int FROM pages WHERE id LIKE ${'imago-%_' + userId} AND "isTrashed" = false) AS "liveRetired",
      (SELECT count(*)::int FROM drive_agent_members WHERE "driveId" = ${`std_${userId}`}) AS grants,
      (SELECT bool_and(p."userScopedAccess") FROM user_builtin_agents u JOIN pages p ON p.id = u."pageId" WHERE u."userId" = ${userId}) AS "userScoped"
  `);
  return rows[0];
}

describe('backfill-imago-agents — IMG-10.10 cleanup (Postgres)', () => {
  it('given --dry-run and a pre-10.10 user with every agent live, should list them for cleanup and write nothing', async () => {
    await seedPre1010User('bf_u_old');
    const before = await rowCounts();

    const { result: summary, output } = await quietly(() => runBackfill({ dryRun: true }));

    expect(summary).toMatchObject({ scanned: 1, missingHome: 0, missingAgents: 0 });
    expect(output).toContain('user bf_u_old: would provision (0 agent(s) missing, cleanup due)');
    expect(await rowCounts()).toEqual(before);
  });

  it('given a pre-10.10 user, should switch Imago to the user\'s reach, trash the retired agents, and drop their pointers and every grant', async () => {
    await seedPre1010User('bf_u_old');

    const { result: summary } = await quietly(() => runBackfill());

    expect(await cleanupStateOf('bf_u_old')).toEqual({ keys: ['imago'], liveRetired: 0, grants: 0, userScoped: true });
    expect(summary).toMatchObject({
      scanned: 1,
      usersProvisioned: 1,
      agentPagesCreated: 0,
      retiredPagesTrashed: 2,
      agentPagesReconciled: 1,
      grantsRemoved: 3,
      failed: 0,
      remainingMissingAgents: 0,
    });
  });

  it('given the cleanup done, should find nobody on a re-run (idempotent)', async () => {
    await seedPre1010User('bf_u_old');
    await quietly(() => runBackfill());
    const before = await rowCounts();

    const { result: summary } = await quietly(() => runBackfill());

    expect(summary).toMatchObject({ scanned: 0, usersProvisioned: 0, remainingMissingAgents: 0 });
    expect(await rowCounts()).toEqual(before);
  });

  it('given only a leftover grant row, should still find the user and remove it', async () => {
    await seedUser('bf_u_grant');
    await seedStandardDrive('bf_u_grant');
    await provisionHomeDriveIfNeeded('bf_u_grant');
    const { imago } = await liveAgentsOf('bf_u_grant');
    await db.execute(sql`
      INSERT INTO drive_agent_members (id, "driveId", "agentPageId", role, "addedBy")
      VALUES ('dam_leftover', 'std_bf_u_grant', ${imago}, 'MEMBER', 'bf_u_grant')`);

    const { result: summary } = await quietly(() => runBackfill());

    expect(summary).toMatchObject({ scanned: 1, grantsRemoved: 1, failed: 0 });
    expect((await cleanupStateOf('bf_u_grant')).grants).toBe(0);
  });
});

describe('parseArgs', () => {
  it('should default to a real run over every user', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, batchSize: 100, limit: undefined });
  });

  it('should read --dry-run, --batch-size and --limit in both spellings', () => {
    expect(parseArgs(['--dry-run', '--batch-size', '25', '--limit=10'])).toEqual({
      dryRun: true,
      batchSize: 25,
      limit: 10,
    });
    expect(parseArgs(['--batch-size=5'])).toMatchObject({ batchSize: 5 });
  });

  it('should reject a non-positive or non-integer size and an unknown flag', () => {
    expect(() => parseArgs(['--batch-size', '0'])).toThrow(/--batch-size/);
    expect(() => parseArgs(['--limit', '-3'])).toThrow(/--limit/);
    expect(() => parseArgs(['--limit', '2.5'])).toThrow(/--limit/);
    expect(() => parseArgs(['--batch-size'])).toThrow(/--batch-size/);
    expect(() => parseArgs(['--dryrun'])).toThrow(/--dryrun/);
  });
});

async function waitForLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const { rows } = await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `);
    if (Number(rows[0].n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the backfill never blocked on the sign-in\'s user-row lock');
}
