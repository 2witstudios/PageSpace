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
import { machineBranches } from '@pagespace/db/schema/machine-branches';
import { machineSpriteReclaims } from '@pagespace/db/schema/machine-sprite-reclaims';
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
      ownerId: userId, machineId, scope: 'machine', projectName: null, machineProjectId: null, machineBranchId: null,
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
      ownerId: userId, machineId, scope: 'machine', projectName: null, machineProjectId: null, machineBranchId: null,
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
      ownerId: userId, machineId, scope: 'machine', projectName: null, machineProjectId: null, machineBranchId: null,
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
      ownerId: userId, machineId, scope: 'project', projectName: PROJECT_NAME, machineProjectId: null, machineBranchId: null,
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
      ownerId: userId, machineId, scope: 'project', projectName: PROJECT_NAME, machineProjectId: null, machineBranchId: null,
      name: 'cli', agentType: 'shell', command: null, now: new Date(),
    });
    // The project is removed (finding V deletes it first) while this spawn is mid-clone.
    await db.delete(machineProjects).where(eq(machineProjects.machineId, machineId));

    const ok = await store.updateSpriteIdentity({ id: row.id, ...IDENTITY });

    expect(ok).toBe(false); // fenced — no stale project-scoped Sprite the project delete can't find
    expect(await readSandboxId(row.id)).toBeNull();
  });
});

/**
 * Project-removal FK cascade (migration 0230) — the mechanism that REPLACED the
 * former manual snapshot/enumeration teardown. Deleting a `machine_projects` row
 * must cascade to its project- AND branch-scoped `machine_agent_terminals` rows
 * and its `machine_branches` rows, and each cascaded row's OWN AFTER-DELETE reclaim
 * trigger (0229 terminals, 0209 branches, 0219 the project itself) must rescue its
 * live Sprite pointer into the `machine_sprite_reclaims` outbox. Only verifiable
 * against Postgres (real FK + real triggers).
 */
describe('project removal cascades to sessions/branches and reclaims every Sprite (migration 0230)', () => {
  async function reclaimIds(): Promise<Set<string>> {
    const rows = await db.select({ sandboxId: machineSpriteReclaims.sandboxId }).from(machineSpriteReclaims);
    return new Set(rows.map((r) => r.sandboxId));
  }

  async function insertProjectRow(ownerId: string, machineId: string, sandboxId: string | null) {
    const id = createId();
    await db.insert(machineProjects).values({
      id, ownerId, machineId, name: PROJECT_NAME,
      repoUrl: 'https://github.com/o/r.git', path: `/workspace/projects/${PROJECT_NAME}`,
      sandboxId, spriteInstanceId: sandboxId ? `inst-${sandboxId}` : null,
    });
    return id;
  }

  it('deletes the project → cascades to its terminals + branch, reclaiming every Sprite; a same-name re-create is untouched', async () => {
    if (!dbAvailable) return;
    const { userId, machineId } = await seedMachine(false);
    // A promoted project (its own Sprite) with a full session tree beneath it.
    const projectId = await insertProjectRow(userId, machineId, 'sbx-project');

    const branchId = createId();
    await db.insert(machineBranches).values({
      id: branchId, ownerId: userId, machineId, projectName: PROJECT_NAME, machineProjectId: projectId,
      branchName: 'feature', sessionKey: `bk-${branchId}`,
      sandboxId: 'sbx-branch', spriteInstanceId: 'inst-branch', updatedAt: new Date(),
    });

    const projectTermId = createId();
    const branchTermId = createId();
    await db.insert(machineAgentTerminals).values([
      {
        id: projectTermId, ownerId: userId, machineId, scope: 'project', projectName: PROJECT_NAME,
        machineProjectId: projectId, machineBranchId: null, name: 'proj-cli', agentType: 'shell',
        sessionKey: `sk-${projectTermId}`, sandboxId: 'sbx-proj-term', spriteInstanceId: 'inst-proj-term',
        updatedAt: new Date(),
      },
      {
        id: branchTermId, ownerId: userId, machineId, scope: 'branch', projectName: PROJECT_NAME,
        machineProjectId: projectId, machineBranchId: branchId, name: 'branch-cli', agentType: 'shell',
        sessionKey: `sk-${branchTermId}`, sandboxId: 'sbx-branch-term', spriteInstanceId: 'inst-branch-term',
        updatedAt: new Date(),
      },
    ]);

    // Delete ONLY the project row — the FK cascade + triggers must do the rest.
    await db.delete(machineProjects).where(eq(machineProjects.id, projectId));

    // Both terminal rows and the branch row are gone (cascaded).
    expect(await readSandboxId(projectTermId)).toBeNull();
    expect(await readSandboxId(branchTermId)).toBeNull();
    const [gone] = await db.select({ id: machineAgentTerminals.id }).from(machineAgentTerminals).where(eq(machineAgentTerminals.id, projectTermId)).limit(1);
    expect(gone).toBeUndefined();
    const [branchGone] = await db.select({ id: machineBranches.id }).from(machineBranches).where(eq(machineBranches.id, branchId)).limit(1);
    expect(branchGone).toBeUndefined();

    // Every live Sprite pointer was rescued into the reclaim outbox — the project's
    // own (0219), the branch's (0209), and BOTH terminals' (0229).
    const reclaimed = await reclaimIds();
    expect(reclaimed.has('sbx-project')).toBe(true);
    expect(reclaimed.has('sbx-branch')).toBe(true);
    expect(reclaimed.has('sbx-proj-term')).toBe(true);
    expect(reclaimed.has('sbx-branch-term')).toBe(true);

    // A same-name project re-created AFTER the delete is a DIFFERENT id, so the
    // cascade never touched it: its session survives.
    const newProjectId = await insertProjectRow(userId, machineId, null);
    expect(newProjectId).not.toBe(projectId);
    const survivorId = createId();
    await db.insert(machineAgentTerminals).values({
      id: survivorId, ownerId: userId, machineId, scope: 'project', projectName: PROJECT_NAME,
      machineProjectId: newProjectId, machineBranchId: null, name: 'proj-cli', agentType: 'shell',
      sessionKey: `sk-${survivorId}`, sandboxId: 'sbx-survivor', spriteInstanceId: 'inst-survivor',
      updatedAt: new Date(),
    });
    expect(await readSandboxId(survivorId)).toBe('sbx-survivor');
    expect((await reclaimIds()).has('sbx-survivor')).toBe(false);
  });
});
