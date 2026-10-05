/**
 * provisionImagoAgents against a REAL Postgres — no fake DB, no vi.mock.
 *
 * What only a real database can show: that the agent pages land in the Home
 * drive with their pointers, that a deleted page's pointer cascade leads to a
 * recreation, and that two provisioners racing for one user produce ONE page
 * per key. The race uses one dedicated single-connection pool per side (a
 * shared pool with DB_POOL_MAX=1 would serialise them before Postgres ever saw
 * them) and observes the loser blocking on the user-row lock in
 * pg_stat_activity, so contention is proven rather than inferred from timing.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when none is
 * reachable; local runs without a database opt out with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { schema } from '@pagespace/db/schema';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { BUILTIN_AGENTS, BUILTIN_AGENT_KEYS } from '../builtin-agents';
import { IMAGO_FOLDER_TITLE, provisionImagoAgents } from '../provision-imago-agents';
import { provisionHomeDriveIfNeeded } from '../../onboarding/home-drive';

let dbAvailable = false;
const pools: Pool[] = [];

const CONTENTION_POLL_MAX_ATTEMPTS = 150;
const CONTENTION_POLL_INTERVAL_MS = 20;

function dedicatedClient() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  pools.push(pool);
  return drizzle(pool, { schema });
}

async function userWithHome() {
  const user = await factories.createUser();
  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  return { user, home };
}

function folderOf(result: { folderId: string | null }): string {
  if (!result.folderId) throw new Error('expected provisioning to report an Imago folder');
  return result.folderId;
}

async function pointersFor(userId: string) {
  return db.select().from(userBuiltinAgents).where(eq(userBuiltinAgents.userId, userId));
}

async function agentPagesIn(driveId: string) {
  return db
    .select()
    .from(pages)
    .where(and(eq(pages.driveId, driveId), eq(pages.type, 'AI_CHAT'), eq(pages.isTrashed, false)));
}

// File level, not inside a describe: both suites below depend on it, and a
// describe-scoped hook would not run when a -t filter skips that describe,
// leaving the other suite to return early and pass vacuously.
beforeAll(async () => {
  try {
    await db.select().from(pages).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('provision-imago-agents.integration.test.ts', error);
    dbAvailable = false;
  }
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
});

describe('provisionImagoAgents (real Postgres)', () => {
  it('given a Home drive, should create the registry agents under an Imago folder and record their pointers', async () => {
    if (!dbAvailable) return;
    const { user, home } = await userWithHome();

    const result = await provisionImagoAgents(user.id);

    expect(result.homeDriveId).toBe(home.id);
    expect([...result.created].sort()).toEqual([...BUILTIN_AGENT_KEYS].sort());

    const [folder] = await db.select().from(pages).where(eq(pages.id, folderOf(result)));
    expect(folder).toMatchObject({
      title: IMAGO_FOLDER_TITLE,
      type: 'FOLDER',
      driveId: home.id,
      parentId: null,
      isTrashed: false,
      createdBy: user.id,
    });

    const pointers = await pointersFor(user.id);
    expect(pointers.map((p) => p.key).sort()).toEqual([...BUILTIN_AGENT_KEYS].sort());

    for (const definition of BUILTIN_AGENTS) {
      const pointer = pointers.find((p) => p.key === definition.key);
      expect(pointer?.pageId).toBe(result.agents[definition.key]);
      const [page] = await db.select().from(pages).where(eq(pages.id, pointer?.pageId ?? ''));
      expect(page).toMatchObject({
        type: 'AI_CHAT',
        title: definition.title,
        driveId: home.id,
        parentId: folder.id,
        isTrashed: false,
        systemPrompt: definition.systemPrompt,
        agentDefinition: definition.agentDefinition,
        enabledTools: [...definition.enabledTools],
        includePageTree: definition.includePageTree,
        createdBy: user.id,
        revision: 0,
      });
      expect(page.stateHash).toBeTruthy();
      expect(page.aiProvider).toBeTruthy();
      expect(page.aiModel).toBeTruthy();
    }
  });

  it('given created agents, should make each a member of the Home drive and log its creation, as the page service does', async () => {
    if (!dbAvailable) return;
    const { user, home } = await userWithHome();

    const result = await provisionImagoAgents(user.id);
    const agentIds = Object.values(result.agents);

    const memberships = await db
      .select()
      .from(driveAgentMembers)
      .where(inArray(driveAgentMembers.agentPageId, agentIds));
    expect(memberships).toHaveLength(BUILTIN_AGENT_KEYS.length);
    for (const membership of memberships) {
      expect(membership).toMatchObject({ driveId: home.id, role: 'MEMBER', addedBy: user.id });
    }

    const logs = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.operation, 'create'), inArray(activityLogs.pageId, [...agentIds, folderOf(result)])));
    expect(logs.map((log) => log.pageId).sort()).toEqual([...agentIds, folderOf(result)].sort());
    for (const log of logs) {
      expect(log).toMatchObject({ userId: user.id, driveId: home.id, resourceType: 'page' });
    }
  });

  it('given agents already provisioned, should create nothing and keep the same pages', async () => {
    if (!dbAvailable) return;
    const { user, home } = await userWithHome();

    const first = await provisionImagoAgents(user.id);
    const second = await provisionImagoAgents(user.id);

    expect(second.created).toEqual([]);
    expect(second.agents).toEqual(first.agents);
    expect(folderOf(second)).toBe(folderOf(first));
    expect(await agentPagesIn(home.id)).toHaveLength(BUILTIN_AGENT_KEYS.length);
    const folders = await db
      .select()
      .from(pages)
      .where(and(eq(pages.driveId, home.id), eq(pages.title, IMAGO_FOLDER_TITLE), eq(pages.type, 'FOLDER')));
    expect(folders).toHaveLength(1);
  });

  it('given a user who deleted an agent page, should recreate it on the next provision', async () => {
    if (!dbAvailable) return;
    const { user, home } = await userWithHome();
    const first = await provisionImagoAgents(user.id);

    // Hard delete: the pointer cascades away with the page.
    await db.delete(pages).where(eq(pages.id, first.agents['imago-planner']));
    expect((await pointersFor(user.id)).map((p) => p.key)).not.toContain('imago-planner');

    const second = await provisionImagoAgents(user.id);

    expect(second.created).toEqual(['imago-planner']);
    expect(second.agents['imago-planner']).not.toBe(first.agents['imago-planner']);
    expect(second.agents.imago).toBe(first.agents.imago);
    expect(second.agents['imago-researcher']).toBe(first.agents['imago-researcher']);
    const pointer = (await pointersFor(user.id)).find((p) => p.key === 'imago-planner');
    expect(pointer?.pageId).toBe(second.agents['imago-planner']);
    const [page] = await db.select().from(pages).where(eq(pages.id, second.agents['imago-planner']));
    expect(page).toMatchObject({ title: 'Imago Planner', parentId: folderOf(first), driveId: home.id, isTrashed: false });
  });

  it('given a user who trashed an agent page, should recreate it and repoint the key', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();
    const first = await provisionImagoAgents(user.id);

    // Trash is what "delete" means in the UI; the pointer row survives it.
    await db.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(eq(pages.id, first.agents.imago));

    const second = await provisionImagoAgents(user.id);

    expect(second.created).toEqual(['imago']);
    expect(second.agents.imago).not.toBe(first.agents.imago);
    const pointers = await pointersFor(user.id);
    expect(pointers).toHaveLength(BUILTIN_AGENT_KEYS.length);
    expect(pointers.find((p) => p.key === 'imago')?.pageId).toBe(second.agents.imago);
  });

  it('given a user who trashed the Imago folder, should recreate the folder and the agents inside it', async () => {
    if (!dbAvailable) return;
    const { user, home } = await userWithHome();
    const first = await provisionImagoAgents(user.id);

    // Trashing a folder trashes its subtree.
    await db
      .update(pages)
      .set({ isTrashed: true, trashedAt: new Date() })
      .where(inArray(pages.id, [folderOf(first), ...Object.values(first.agents)]));

    const second = await provisionImagoAgents(user.id);

    expect(folderOf(second)).not.toBe(folderOf(first));
    expect([...second.created].sort()).toEqual([...BUILTIN_AGENT_KEYS].sort());
    const live = await agentPagesIn(home.id);
    expect(live).toHaveLength(BUILTIN_AGENT_KEYS.length);
    for (const page of live) expect(page.parentId).toBe(folderOf(second));
  });

  it('given live agents moved out of a deleted Imago folder, should not recreate the empty folder', async () => {
    if (!dbAvailable) return;
    const { user, home } = await userWithHome();
    const first = await provisionImagoAgents(user.id);
    await db.update(pages).set({ parentId: null }).where(inArray(pages.id, Object.values(first.agents)));
    await db.delete(pages).where(eq(pages.id, folderOf(first)));

    const second = await provisionImagoAgents(user.id);

    expect(second.created).toEqual([]);
    expect(second.folderId).toBeNull();
    expect(second.agents).toEqual(first.agents);
    const folders = await db
      .select()
      .from(pages)
      .where(and(eq(pages.driveId, home.id), eq(pages.title, IMAGO_FOLDER_TITLE), eq(pages.type, 'FOLDER')));
    expect(folders).toHaveLength(0);
  });

  it('given a user without a Home drive, should refuse rather than invent one', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();

    await expect(provisionImagoAgents(user.id)).rejects.toThrow(/no Home drive/);
    expect(await pointersFor(user.id)).toHaveLength(0);
  });

  it('given two concurrent calls for one user, should produce exactly one page per key', async () => {
    if (!dbAvailable) return;
    const { user, home } = await userWithHome();

    const [a, b] = await Promise.all([
      provisionImagoAgents(user.id, dedicatedClient()),
      provisionImagoAgents(user.id, dedicatedClient()),
    ]);

    // One side created all three; the other found them.
    expect([a.created.length, b.created.length].sort()).toEqual([0, BUILTIN_AGENT_KEYS.length]);
    expect(a.agents).toEqual(b.agents);

    const dupes = await db.execute(sql`
      SELECT title, type, COUNT(*) AS n FROM ${pages}
      WHERE ${pages.driveId} = ${home.id} AND ${pages.isTrashed} = false
      GROUP BY title, type HAVING COUNT(*) > 1
    `);
    expect(dupes.rows).toHaveLength(0);
    expect(await agentPagesIn(home.id)).toHaveLength(BUILTIN_AGENT_KEYS.length);
    expect(await pointersFor(user.id)).toHaveLength(BUILTIN_AGENT_KEYS.length);
  });

  it('proves a concurrent provisioner blocks on the user row lock', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();

    const holder = dedicatedClient();
    let release: () => void = () => undefined;
    let announceHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockHeld = new Promise<void>((resolve) => {
      announceHeld = resolve;
    });

    const holding = holder.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${user.id} FOR UPDATE`);
      announceHeld();
      await held;
    });

    await lockHeld;
    const provisioning = provisionImagoAgents(user.id, dedicatedClient());

    let observedLockWait = false;
    for (let attempt = 0; attempt < CONTENTION_POLL_MAX_ATTEMPTS; attempt++) {
      const waiting = await db.execute(sql`
        SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'
      `);
      if (waiting.rows.length > 0) {
        observedLockWait = true;
        break;
      }
      await new Promise((r) => setTimeout(r, CONTENTION_POLL_INTERVAL_MS));
    }

    release();
    await holding;
    const result = await provisioning;

    expect(observedLockWait).toBe(true);
    expect(result.created).toHaveLength(BUILTIN_AGENT_KEYS.length);
  });
});

describe('provisionHomeDriveIfNeeded → Imago agents (real Postgres)', () => {
  it('given a new user, should provision the Home drive with the Imago agents', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();

    const { driveId, created } = await provisionHomeDriveIfNeeded(user.id);

    expect(created).toBe(true);
    const pointers = await pointersFor(user.id);
    expect(pointers.map((p) => p.key).sort()).toEqual([...BUILTIN_AGENT_KEYS].sort());
    const agentPages = await db.select().from(pages).where(inArray(pages.id, pointers.map((p) => p.pageId)));
    for (const page of agentPages) expect(page.driveId).toBe(driveId);
  });

  it('given a returning user whose Home drive predates the agents, should provision them on the next sign-in', async () => {
    if (!dbAvailable) return;
    const { user, home } = await userWithHome();
    expect(await pointersFor(user.id)).toHaveLength(0);

    const { driveId, created } = await provisionHomeDriveIfNeeded(user.id);

    expect(created).toBe(false);
    expect(driveId).toBe(home.id);
    expect(await pointersFor(user.id)).toHaveLength(BUILTIN_AGENT_KEYS.length);
    expect(await agentPagesIn(home.id)).toHaveLength(BUILTIN_AGENT_KEYS.length);

    // Every later sign-in is a no-op for the agents.
    await provisionHomeDriveIfNeeded(user.id);
    expect(await agentPagesIn(home.id)).toHaveLength(BUILTIN_AGENT_KEYS.length);
  });

  // Concurrent first sign-ins of DIFFERENT users all allocate from the "home"
  // publish-subdomain family. The loser of a candidate hits the unique index
  // inside its Home transaction; the allocator's retry must survive that rather
  // than fail on an aborted transaction (the agent provisioning lengthens the
  // Home transaction, which widens this window).
  it('given concurrent first sign-ins of different users, should provision every Home drive', async () => {
    if (!dbAvailable) return;
    const newUsers = await Promise.all([1, 2, 3, 4].map(() => factories.createUser()));

    const results = await Promise.allSettled(newUsers.map((user) => provisionHomeDriveIfNeeded(user.id)));

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const homes = await db
      .select({ subdomain: drives.publishSubdomain })
      .from(drives)
      .where(and(inArray(drives.ownerId, newUsers.map((user) => user.id)), eq(drives.kind, 'HOME')));
    expect(homes).toHaveLength(newUsers.length);
    expect(new Set(homes.map((home) => home.subdomain)).size).toBe(newUsers.length);
    for (const user of newUsers) expect(await pointersFor(user.id)).toHaveLength(BUILTIN_AGENT_KEYS.length);
  });

  it('given an existing user owning other drives, should create Home with the agents but no tutorial content', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();
    await factories.createDrive(user.id, { name: 'Work', slug: 'work' });

    const { driveId, created } = await provisionHomeDriveIfNeeded(user.id);

    expect(created).toBe(false);
    const [home] = await db.select().from(drives).where(eq(drives.id, driveId));
    expect(home.kind).toBe('HOME');
    expect(await agentPagesIn(driveId)).toHaveLength(BUILTIN_AGENT_KEYS.length);
  });
});
