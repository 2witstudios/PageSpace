/**
 * Auto-created sessions run in an ENV, not a fresh Sprite each (single-sandbox model).
 *
 * The bug this pins: every Global Assistant conversation spawned a session with
 * its own Sprite, nothing ended them, hibernated Sprites still counted as live,
 * and the owner hit the live-session cap with stale sessions. An env-bound
 * session holds NO Sprite of its own (CHECK `agent_workspaces_env_no_sprite_check`)
 * — it reads the env's — so binding auto-sessions to the owner's Home env
 * removes the pile-up at its source.
 *
 * Against a REAL migration-built Postgres, because the facts are the rows:
 * which env a session row carries, how many Home envs exist, and whether any
 * session row holds Sprite pointers.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable;
 * local runs without Docker opt out explicitly with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, isNotNull } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import { resolveOrCreateConversation } from '@/lib/repositories/resolve-or-create-conversation';
import { conversations } from '@pagespace/db/schema/conversations';
import {
  ensureDriveSessionForConversation,
  ensureGlobalSandboxSession,
  ensureHomeEnvForOwner,
} from '../agent-workspaces-runtime';
import { resolveCallerSessionForWorker } from '@/lib/ai/tools/session-tools-runtime';

/** When set, the Home env is refused as an org policy would refuse it — the fail-open path. */
const homeRefusal = vi.hoisted(() => ({ refuse: false }));

vi.mock('@/lib/drive-envs/drive-envs-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/drive-envs/drive-envs-runtime')>();
  return {
    ...actual,
    ensureHomeEnvInDrive: async (input: Parameters<typeof actual.ensureHomeEnvInDrive>[0]) =>
      homeRefusal.refuse
        ? { ok: false as const, reason: 'org_policy' as const, message: 'Persistent environments are off' }
        : actual.ensureHomeEnvInDrive(input),
  };
});

let dbAvailable = false;

async function homeDriveIdOf(ownerId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: drives.id })
    .from(drives)
    .where(and(eq(drives.ownerId, ownerId), eq(drives.kind, 'HOME')))
    .limit(1);
  return row?.id ?? null;
}

async function homeEnvsOf(homeDriveId: string) {
  return db.select().from(driveEnvs).where(and(eq(driveEnvs.driveId, homeDriveId), eq(driveEnvs.isHome, true)));
}

async function globalConversation(ownerId: string): Promise<string> {
  const id = createId();
  await resolveOrCreateConversation(ownerId, id);
  return id;
}

async function pageConversation(ownerId: string, agentId: string): Promise<string> {
  const id = createId();
  await db.insert(conversations).values({ id, userId: ownerId, type: 'page', contextId: agentId, isActive: true });
  return id;
}

describe('auto-created sessions bind to an env (single-sandbox model)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('home-env-binding.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    homeRefusal.refuse = false;
  });

  it('given a Global Assistant conversation, should bind its session to the owner\'s Home env in the Home drive, keeping its label', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();

    const ensured = await ensureGlobalSandboxSession(await globalConversation(owner.id), credentialActor(owner.id, null));

    if (!ensured.ok) throw new Error(`ensure failed: ${ensured.reason}`);
    const homeDriveId = await homeDriveIdOf(owner.id);
    const [home] = await homeEnvsOf(homeDriveId as string);
    expect(home).toMatchObject({ name: 'Home', isHome: true, createdBy: owner.id });
    expect(ensured.session).toMatchObject({ driveId: homeDriveId, envId: home.id, name: 'Global Assistant' });
  });

  it('given twelve Global Assistant conversations, should run them all on ONE machine — the Home env — with no per-conversation Sprite', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    const actor = credentialActor(owner.id, null);

    const sessions = [];
    for (let i = 0; i < 12; i += 1) {
      const ensured = await ensureGlobalSandboxSession(await globalConversation(owner.id), actor);
      if (!ensured.ok) throw new Error(`ensure ${i} failed: ${ensured.reason}`);
      sessions.push(ensured.session);
    }

    const homeDriveId = await homeDriveIdOf(owner.id);
    const homes = await homeEnvsOf(homeDriveId as string);
    expect(homes).toHaveLength(1);
    expect(new Set(sessions.map((session) => session.envId))).toEqual(new Set([homes[0].id]));
    // No session row holds a Sprite of its own: the only machine is the env's.
    const withSprites = await db
      .select({ id: agentWorkspaces.id })
      .from(agentWorkspaces)
      .where(and(eq(agentWorkspaces.ownerId, owner.id), isNotNull(agentWorkspaces.sandboxId)));
    expect(withSprites).toHaveLength(0);
  });

  it('given the owner\'s Imago conversation, should bind its session to Home too', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    const home = await ensureHomeEnvForOwner(owner.id);
    if (!home.ok) throw new Error('expected Home');

    const ensured = await ensureDriveSessionForConversation(
      await globalConversation(owner.id),
      credentialActor(owner.id, null),
      home.homeDriveId,
      'Imago',
      'home',
    );

    if (!ensured.ok) throw new Error(`ensure failed: ${ensured.reason}`);
    expect(ensured.session).toMatchObject({ driveId: home.homeDriveId, envId: home.envId, name: 'Imago' });
  });

  it('given concurrent first uses of Home, should leave exactly one Home env', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    await ensureHomeEnvForOwner(owner.id);
    const homeDriveId = (await homeDriveIdOf(owner.id)) as string;
    await db.delete(driveEnvs).where(eq(driveEnvs.driveId, homeDriveId));

    const results = await Promise.all(Array.from({ length: 5 }, () => ensureHomeEnvForOwner(owner.id)));

    expect(results.every((result) => result.ok)).toBe(true);
    expect(await homeEnvsOf(homeDriveId)).toHaveLength(1);
  });

  it('given a page agent with Sandbox on and a defaultEnvId, should bind its auto-session to that env', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: `dev-${createId()}`, updatedAt: new Date() }).returning();
    const agent = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Builder', sandboxEnabled: true, defaultEnvId: env.id });

    const resolved = await resolveCallerSessionForWorker(await pageConversation(owner.id, agent.id), credentialActor(owner.id, null));

    if (!resolved.ok) throw new Error(`resolve failed: ${resolved.reason}`);
    expect(resolved.session).toMatchObject({ driveId: drive.id, envId: env.id, name: 'Builder' });
  });

  it('given a page agent in a team drive with no default env, should stay ephemeral — Home lives in the Home drive', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agent = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Plain' });

    const resolved = await resolveCallerSessionForWorker(await pageConversation(owner.id, agent.id), credentialActor(owner.id, null));

    if (!resolved.ok) throw new Error(`resolve failed: ${resolved.reason}`);
    expect(resolved.session).toMatchObject({ driveId: drive.id, envId: null });
  });

  it('given a page agent whose default env was deleted, should fall back to an ephemeral session rather than fail', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);

    const ensured = await ensureDriveSessionForConversation(
      await globalConversation(owner.id),
      credentialActor(owner.id, null),
      drive.id,
      'Builder',
      createId(),
    );

    if (!ensured.ok) throw new Error(`ensure failed: ${ensured.reason}`);
    expect(ensured.session).toMatchObject({ driveId: drive.id, envId: null });
  });

  it('given Home is refused (org policy), should fall back to the ephemeral global session it minted before', async () => {
    if (!dbAvailable) return;
    homeRefusal.refuse = true;
    const owner = await factories.createUser();

    const ensured = await ensureGlobalSandboxSession(await globalConversation(owner.id), credentialActor(owner.id, null));

    if (!ensured.ok) throw new Error(`ensure failed: ${ensured.reason}`);
    expect(ensured.session).toMatchObject({ driveId: await homeDriveIdOf(owner.id), envId: null, name: 'Global Assistant' });
  });
});
