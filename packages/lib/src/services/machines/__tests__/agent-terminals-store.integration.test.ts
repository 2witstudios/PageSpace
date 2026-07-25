/**
 * Agent-terminals store integration tests (Postgres) — the liveness-fenced
 * `updateSpriteIdentity` CAS (findings BB/CC).
 *
 * The identity-persist CAS is fused with a liveness check so a spawn that raced a
 * machine trash or a project removal can never persist a live Sprite pointer that
 * teardown already finished enumerating — the fused WHERE writes ONLY IF, at that
 * instant, the owning Machine page is NOT soft-trashed AND (for a project-scoped
 * row) its `machine_projects` row still exists. This is a real correlated SQL
 * subquery, so it can only be verified against Postgres. Skips gracefully when no
 * DB is reachable (same convention as the other *.integration.test.ts here).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { machineProjects } from '@pagespace/db/schema/machine-projects';
import { machineAgentTerminals } from '@pagespace/db/schema/machine-agent-terminals';
import { factories } from '@pagespace/db/test/factories';
import { createDbMachineAgentTerminalStore } from '../agent-terminals-store';

let dbAvailable = false;

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

const PROJECT_NAME = 'my-repo';

/** A fresh (user, drive, MACHINE page) triple; `trashed` controls the page's soft-trash state. */
async function seedMachine(trashed: boolean) {
  const user = await factories.createUser();
  const drive = await factories.createDrive(user.id);
  const machine = await factories.createPage(drive.id, { type: 'MACHINE' as never, isTrashed: trashed });
  return { userId: user.id, machineId: machine.id };
}

async function insertProject(ownerId: string, machineId: string) {
  await db.insert(machineProjects).values({
    id: createId(),
    ownerId,
    machineId,
    name: PROJECT_NAME,
    repoUrl: 'https://github.com/o/r.git',
    path: `/workspace/projects/${PROJECT_NAME}`,
  });
}

async function readSandboxId(id: string): Promise<string | null> {
  const [row] = await db
    .select({ sandboxId: machineAgentTerminals.sandboxId })
    .from(machineAgentTerminals)
    .where(eq(machineAgentTerminals.id, id))
    .limit(1);
  return row?.sandboxId ?? null;
}

const IDENTITY = {
  previousSandboxId: null,
  sessionKey: 'pgs-agt-live',
  sandboxId: 'sbx-live',
  spriteInstanceId: 'inst-live',
  egressPolicyToken: null,
  now: new Date(),
};

describe('createDbMachineAgentTerminalStore().updateSpriteIdentity — liveness fence (Postgres)', () => {
  it('given a LIVE machine, a machine-scope row persists its identity (returns true)', async () => {
    if (!dbAvailable) return;
    const store = await createDbMachineAgentTerminalStore();
    const { userId, machineId } = await seedMachine(false);
    const row = await store.create({
      ownerId: userId, machineId, scope: 'machine', projectName: null, machineBranchId: null,
      name: 'cli', agentType: 'shell', command: null, now: new Date(),
    });

    const ok = await store.updateSpriteIdentity({ id: row.id, ...IDENTITY });

    expect(ok).toBe(true);
    expect(await readSandboxId(row.id)).toBe('sbx-live');
  });

  it('given a TRASHED machine (finding BB), the CAS FENCES the persist (returns false, sandboxId stays null)', async () => {
    if (!dbAvailable) return;
    const store = await createDbMachineAgentTerminalStore();
    const { userId, machineId } = await seedMachine(true); // soft-trashed
    const row = await store.create({
      ownerId: userId, machineId, scope: 'machine', projectName: null, machineBranchId: null,
      name: 'cli', agentType: 'shell', command: null, now: new Date(),
    });

    const ok = await store.updateSpriteIdentity({ id: row.id, ...IDENTITY });

    expect(ok).toBe(false); // fenced — no orphan pointer under a deleted Machine
    expect(await readSandboxId(row.id)).toBeNull();
  });

  it('given a LIVE machine whose page is trashed BETWEEN reserve and persist, the CAS fences (returns false)', async () => {
    if (!dbAvailable) return;
    const store = await createDbMachineAgentTerminalStore();
    const { userId, machineId } = await seedMachine(false);
    const row = await store.create({
      ownerId: userId, machineId, scope: 'machine', projectName: null, machineBranchId: null,
      name: 'cli', agentType: 'shell', command: null, now: new Date(),
    });
    // The trash lands after the row is reserved but before the persist.
    await db.update(pages).set({ isTrashed: true }).where(eq(pages.id, machineId));

    const ok = await store.updateSpriteIdentity({ id: row.id, ...IDENTITY });

    expect(ok).toBe(false);
    expect(await readSandboxId(row.id)).toBeNull();
  });

  it('given a project-scope row whose project STILL EXISTS, persists (returns true)', async () => {
    if (!dbAvailable) return;
    const store = await createDbMachineAgentTerminalStore();
    const { userId, machineId } = await seedMachine(false);
    await insertProject(userId, machineId);
    const row = await store.create({
      ownerId: userId, machineId, scope: 'project', projectName: PROJECT_NAME, machineBranchId: null,
      name: 'cli', agentType: 'shell', command: null, now: new Date(),
    });

    const ok = await store.updateSpriteIdentity({ id: row.id, ...IDENTITY });

    expect(ok).toBe(true);
    expect(await readSandboxId(row.id)).toBe('sbx-live');
  });

  it('given a project-scope row whose project ROW is GONE (finding CC), the CAS FENCES the persist (returns false)', async () => {
    if (!dbAvailable) return;
    const store = await createDbMachineAgentTerminalStore();
    const { userId, machineId } = await seedMachine(false);
    await insertProject(userId, machineId);
    const row = await store.create({
      ownerId: userId, machineId, scope: 'project', projectName: PROJECT_NAME, machineBranchId: null,
      name: 'cli', agentType: 'shell', command: null, now: new Date(),
    });
    // The project is removed (finding V deletes it first) while this spawn is mid-clone.
    await db.delete(machineProjects).where(eq(machineProjects.machineId, machineId));

    const ok = await store.updateSpriteIdentity({ id: row.id, ...IDENTITY });

    expect(ok).toBe(false); // fenced — no stale project-scoped Sprite the project delete can't find
    expect(await readSandboxId(row.id)).toBeNull();
  });
});
