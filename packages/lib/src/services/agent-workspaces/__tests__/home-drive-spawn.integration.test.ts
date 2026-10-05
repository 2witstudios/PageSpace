/**
 * Global-assistant sessions are born in the owner's Home drive — REAL Postgres.
 *
 * IMG-5.1. A driveless (global-assistant) spawn used to write
 * `agent_workspaces.driveId = NULL`; it now resolves the owner's Home drive —
 * provisioning it through `provisionHomeDriveIfNeeded` when missing — and
 * writes that instead. The unit suite pins the wiring against a fake store;
 * what only the database can answer is pinned here:
 *
 *  1. The row really lands in a `kind = 'HOME'` drive the owner owns, and a
 *     user with no Home drive gets one (and only one, even under concurrent
 *     spawns — `provisionHomeDriveIfNeeded` serializes on the user row).
 *  2. The Sprite key, payer and tenant a Home-drive row resolves to are the
 *     SAME values the old null-drive row resolved to for the same owner, read
 *     through the real resolvers (`resolveSessionTenantId`,
 *     `resolveSessionPayerId` + `lookupDriveOwnerId`) and the real provision
 *     path (`ensureAgentSessionSandbox`, fake Sprite host) — so moving the row
 *     into Home changes neither who pays nor which VM the session holds.
 *  3. No spawn shape leaves a null `driveId` behind.
 *
 * Runs in CI (the Unit Tests job provides Postgres). Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test -- src/services/agent-workspaces/__tests__/home-drive-spawn.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNull } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { machineSpriteReclaims } from '@pagespace/db/schema/machine-sprite-reclaims';
import { provisionHomeDriveIfNeeded } from '../../../onboarding/home-drive';
import { resolveSessionPayerId, lookupDriveOwnerId } from '../../../billing/sandbox-payer';
import { deriveAgentSessionSpriteKey } from '../../../agent-workspaces/workspace-sprite-key';
import { resolveSessionTenantId } from '../agent-workspace-tenant';
import { createDbAgentSessionStore, type AgentSessionRecord, type AgentSessionStore } from '../agent-workspaces-store';
import { spawnAgentSession, type SpawnAgentSessionDeps } from '../agent-workspaces';
import { ensureAgentSessionSandbox } from '../agent-workspace-sprite';
import { makeSpriteHost } from './fakes';

/** >= 32 chars — the key derivation refuses anything shorter. */
const SECRET = 'home-drive-spawn-integration-secret-0123456789';

/** A user with NO Home drive at the start — the provisioning case. */
const homelessOwnerId = createId();
/** A user whose Home drive exists before the spawn, plus an ordinary drive. */
const homedOwnerId = createId();
const homedOwnerDriveId = createId();
/** Concurrent-spawn subject, also starting with no Home drive. */
const racingOwnerId = createId();
const ownerIds = [homelessOwnerId, homedOwnerId, racingOwnerId];

let store: AgentSessionStore;
const sandboxIds = new Set<string>();

function spawnDeps(): SpawnAgentSessionDeps {
  return {
    store,
    now: () => new Date(),
    maxActiveSessions: 100,
    findEnv: async () => null,
    gateLocalEnvBind: async () => {
      throw new Error('no local env in this suite');
    },
    // The production binding: the web runtime wires exactly this.
    resolveHomeDriveId: async (ownerId) => (await provisionHomeDriveIfNeeded(ownerId)).driveId,
  };
}

async function spawnGlobal(ownerId: string): Promise<AgentSessionRecord> {
  const result = await spawnAgentSession({ ownerId, driveId: null, name: 'Global Assistant', deps: spawnDeps() });
  if (!result.ok) throw new Error(`spawn failed: ${JSON.stringify(result)}`);
  return result.session;
}

async function homeDrivesOf(ownerId: string) {
  return db
    .select({ id: drives.id })
    .from(drives)
    .where(and(eq(drives.ownerId, ownerId), eq(drives.kind, 'HOME')));
}

beforeAll(async () => {
  store = await createDbAgentSessionStore();
  await db.insert(users).values(
    ownerIds.map((id) => ({ id, email: `home-drive-spawn-${id}@example.test`, name: 'Home Drive Spawn Test' })),
  );
  await provisionHomeDriveIfNeeded(homedOwnerId);
  await db.insert(drives).values({
    id: homedOwnerDriveId,
    name: 'Team Drive',
    slug: `team-${homedOwnerDriveId}`,
    ownerId: homedOwnerId,
  });
});

afterAll(async () => {
  const rows = await db
    .select({ sandboxId: agentWorkspaces.sandboxId })
    .from(agentWorkspaces)
    .where(inArray(agentWorkspaces.ownerId, ownerIds));
  for (const row of rows) if (row.sandboxId) sandboxIds.add(row.sandboxId);
  await db.delete(agentWorkspaces).where(inArray(agentWorkspaces.ownerId, ownerIds));
  if (sandboxIds.size > 0) {
    await db.delete(machineSpriteReclaims).where(inArray(machineSpriteReclaims.sandboxId, [...sandboxIds]));
  }
  await db.delete(drives).where(inArray(drives.ownerId, ownerIds));
  await db.delete(users).where(inArray(users.id, ownerIds));
});

describe("global-assistant spawn — the owner's Home drive", () => {
  it('given an owner with no Home drive, should provision one and create the session in it', async () => {
    expect(await homeDrivesOf(homelessOwnerId)).toHaveLength(0);

    const session = await spawnGlobal(homelessOwnerId);

    const homes = await homeDrivesOf(homelessOwnerId);
    expect(homes).toHaveLength(1);
    const [persisted] = await db.select().from(agentWorkspaces).where(eq(agentWorkspaces.id, session.id));
    expect(persisted.driveId).toBe(homes[0].id);
    expect(persisted.ownerId).toBe(homelessOwnerId);
    expect(persisted.envId).toBeNull();
  });

  it('given an owner whose Home drive exists, should reuse it — never a second Home', async () => {
    const [home] = await homeDrivesOf(homedOwnerId);

    const first = await spawnGlobal(homedOwnerId);
    const second = await spawnGlobal(homedOwnerId);

    expect(first.driveId).toBe(home.id);
    expect(second.driveId).toBe(home.id);
    expect(await homeDrivesOf(homedOwnerId)).toHaveLength(1);
  });

  it('given concurrent first spawns for an owner with no Home drive, should provision exactly ONE Home and put both sessions in it', async () => {
    const sessions = await Promise.all([spawnGlobal(racingOwnerId), spawnGlobal(racingOwnerId), spawnGlobal(racingOwnerId)]);

    const homes = await homeDrivesOf(racingOwnerId);
    expect(homes).toHaveLength(1);
    expect(new Set(sessions.map((s) => s.driveId))).toEqual(new Set([homes[0].id]));
  });

  it('given a drive spawn, should keep the drive it was given', async () => {
    const result = await spawnAgentSession({ ownerId: homedOwnerId, driveId: homedOwnerDriveId, deps: spawnDeps() });
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.driveId).toBe(homedOwnerDriveId);
  });
});

describe('Home-drive row vs the null-drive row it replaces — same Sprite key, payer and tenant', () => {
  it('should resolve the tenant to the owner, exactly as a null-drive row did', async () => {
    const session = await spawnGlobal(homelessOwnerId);
    expect(session.driveId).not.toBeNull();

    const asHome = await resolveSessionTenantId(session);
    const asNull = await resolveSessionTenantId({ ownerId: session.ownerId, driveId: null });

    expect(asHome).toEqual({ ok: true, tenantId: homelessOwnerId });
    expect(asHome).toEqual(asNull);
  });

  it('should resolve the payer to the owner, exactly as a null-drive row did', async () => {
    const session = await spawnGlobal(homelessOwnerId);

    const asHome = await resolveSessionPayerId({ driveId: session.driveId, ownerId: session.ownerId, lookupDriveOwnerId });
    const asNull = await resolveSessionPayerId({ driveId: null, ownerId: session.ownerId, lookupDriveOwnerId });

    expect(asHome).toBe(homelessOwnerId);
    expect(asHome).toBe(asNull);
  });

  it('should provision the SAME Sprite key a null-drive row would have folded', async () => {
    const session = await spawnGlobal(homelessOwnerId);
    const tenant = await resolveSessionTenantId(session);
    if (!tenant.ok) throw new Error('expected a tenant');
    const host = makeSpriteHost();

    // The real provision path — the tenant folded into the key is whatever the
    // Home-drive row resolves, exactly as `provisionSessionSandbox` passes it.
    const ensured = await ensureAgentSessionSandbox({
      row: { ...session, workspaceId: session.id },
      intent: 'ensure',
      actor: { userId: session.ownerId, tenantId: tenant.tenantId },
      deps: {
        store,
        host: host.host,
        substrate: { kind: 'sprite' },
        options: {},
        secret: SECRET,
        authorize: async () => ({ ok: true }),
        checkFullEgressEnablement: async () => ({ ok: true }),
        checkConcurrency: async () => ({ allowed: true }),
        ensureEnvSandbox: async () => {
          throw new Error('not env-bound');
        },
        now: () => new Date(),
      },
    });
    if (!ensured.ok) throw new Error(`ensure failed: ${JSON.stringify(ensured)}`);

    const [persisted] = await db.select().from(agentWorkspaces).where(eq(agentWorkspaces.id, session.id));
    if (persisted.sandboxId) sandboxIds.add(persisted.sandboxId);
    const nullDriveTenant = await resolveSessionTenantId({ ownerId: session.ownerId, driveId: null });
    if (!nullDriveTenant.ok) throw new Error('expected a tenant');
    const nullDriveKey = deriveAgentSessionSpriteKey({
      tenantId: nullDriveTenant.tenantId,
      workspaceId: session.id,
      secret: SECRET,
    });

    expect(persisted.spriteKey).toBe(nullDriveKey);
  });
});

describe('no spawn path inserts a null driveId', () => {
  it('given every spawn shape, should leave zero null-drive rows for these owners', async () => {
    await spawnGlobal(homedOwnerId);
    await spawnAgentSession({ ownerId: homedOwnerId, driveId: homedOwnerDriveId, deps: spawnDeps() });

    const nullRows = await db
      .select({ id: agentWorkspaces.id })
      .from(agentWorkspaces)
      .where(and(inArray(agentWorkspaces.ownerId, ownerIds), isNull(agentWorkspaces.driveId)));
    const allRows = await db
      .select({ id: agentWorkspaces.id })
      .from(agentWorkspaces)
      .where(inArray(agentWorkspaces.ownerId, ownerIds));

    expect(allRows.length).toBeGreaterThan(0);
    expect(nullRows).toEqual([]);
  });
});
