/**
 * Sessions INSIDE an environment — REAL Postgres, fake Sprites.
 *
 * The unit suites already pin the routing (`agent-workspace-sprite.test.ts`) and
 * the spawn validation (`agent-workspaces.test.ts`) against in-memory fakes,
 * which is the right tool for those. They cannot speak to the four claims this
 * epic actually rests on, because each is a claim about what the DATABASE does:
 *
 *  1. **Two sessions in one env resolve the SAME sandbox.** Nothing threads a
 *     shared handle around — the Sprite name folds the ENV's id, so sharing is
 *     a property of the derivation. A fake store would agree with that whether
 *     or not the real one wrote the pointer to the row both sessions read.
 *  2. **Concurrent first-ensures yield exactly ONE VM.** That is the identity
 *     CAS on the `drive_envs` row, executed by two connections at once. A fake
 *     models the CAS; only Postgres runs it.
 *  3. **Ending an env session touches no Sprite.** Structural, via the DB CHECK
 *     that keeps every Sprite column on that row null — so the end planner sees
 *     `sandboxId: null` and stamps `endedAt`. Pinned here WITH the constraint
 *     that makes it structural, rather than against a fake that could be
 *     written to allow the state the database forbids.
 *  4. **An env delete is refused while a session lives.** That guard already
 *     exists in `deleteDriveEnv` and is covered in the store's own integration
 *     suite; what is new here is a session that got there by being SPAWNED into
 *     the env and PROVISIONED through it.
 *
 * The Sprite host is faked deliberately: the assertions are about which row
 * holds which pointer and how many VMs were minted, and a fake host reports
 * both exactly while a real one would make the suite un-runnable in CI.
 *
 * Runs in CI (the Unit Tests job provides Postgres). Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test -- src/services/drive-envs/__tests__/env-sessions.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { machineSpriteReclaims } from '@pagespace/db/schema/machine-sprite-reclaims';
import { createDbDriveEnvStore, type DriveEnvStore } from '../drive-envs-store';
import { deleteDriveEnv } from '../drive-envs';
import { deriveDriveEnvSpriteKey } from '../../../drive-envs/env-sprite-key';
import {
  createDbAgentSessionStore,
  type AgentSessionRecord,
  type AgentSessionStore,
} from '../../agent-workspaces/agent-workspaces-store';
import { spawnAgentSession, endAgentSession } from '../../agent-workspaces/agent-workspaces';
import {
  ensureAgentSessionSandbox,
  ensureSpriteHolderSandbox,
  type SpriteHolderProvisionIntent,
} from '../../agent-workspaces/agent-workspace-sprite';
import { makeSpriteHost, type FakeSpriteHost } from '../../agent-workspaces/__tests__/fakes';

/** >= 32 chars — the key derivations refuse anything shorter. */
const SECRET = 'env-session-integration-secret-key-0123456789';

const payerId = createId();
const driveId = createId();
const otherDriveId = createId();
/** Every sandbox name this file lets reach the DB — the reclaim outbox is FK-less, so teardown sweeps it by name. */
const sandboxIds = new Set<string>();

let envStore: DriveEnvStore;
let sessionStore: AgentSessionStore;

/**
 * The env's provisioning, bound the way both app tiers bind it — the REAL
 * `drive_envs` store slice and the ONE `ensureSpriteHolderSandbox` core, with
 * only the gates faked. The Sprite key is the real `drive-env-sprite:v1`
 * derivation, because "two sessions land on one VM" is a claim about that fold.
 */
function ensureEnvSandbox(host: FakeSpriteHost) {
  return async ({ envId, intent }: { envId: string; intent: SpriteHolderProvisionIntent }) => {
    const row = await envStore.findById(envId);
    if (!row) return { ok: false as const, reason: 'provision_failed' as const, detail: 'env_not_found' };
    return ensureSpriteHolderSandbox({
      row: { ...row, holderId: row.id, endedAt: null },
      intent,
      deps: {
        store: {
          updateSpriteIdentity: ({ holderId, ...identity }) =>
            envStore.updateSpriteIdentity({ envId: holderId, ...identity }),
          applyStamps: ({ holderId, stamps, cas }) => envStore.applyStamps({ envId: holderId, stamps, cas }),
          reloadSpritePointer: (holderId) => envStore.reloadSpritePointer(holderId),
          enqueueReclaim: (reclaim) => {
            sandboxIds.add(reclaim.sandboxId);
            return envStore.enqueueReclaim(reclaim);
          },
        },
        host: host.host,
        substrate: { kind: 'sprite' },
        options: {},
        deriveSpriteKey: (holderId) =>
          deriveDriveEnvSpriteKey({ tenantId: payerId, envId: holderId, secret: SECRET }),
        authorize: async () => ({ ok: true }),
        checkFullEgressEnablement: async () => ({ ok: true }),
        checkQuota: async () => ({ allowed: true }),
        now: () => new Date(),
      },
    });
  };
}

/** Ensure a SESSION's sandbox through the shared entry point — the router under test. */
async function ensureForSession(row: AgentSessionRecord, host: FakeSpriteHost) {
  return ensureAgentSessionSandbox({
    row: { ...row, workspaceId: row.id },
    intent: 'ensure',
    actor: { userId: payerId, tenantId: payerId },
    deps: {
      store: sessionStore,
      host: host.host,
      substrate: { kind: 'sprite' },
      options: {},
      secret: SECRET,
      authorize: async () => ({ ok: true }),
      checkFullEgressEnablement: async () => ({ ok: true }),
      checkConcurrency: async () => ({ allowed: true }),
      ensureEnvSandbox: ensureEnvSandbox(host),
      now: () => new Date(),
    },
  });
}

async function seedEnv(name = `env-${createId().slice(0, 8)}`, inDrive = driveId): Promise<string> {
  const created = await envStore.createIfUnderLimit({
    driveId: inDrive,
    name,
    createdBy: payerId,
    payerId,
    maxEnvs: 1_000,
    now: new Date(),
  });
  if (!created.ok) throw new Error(`seedEnv refused: ${created.reason}`);
  return created.env.id;
}

/** The spawn, with its result union intact — for the cases where refusal IS the assertion. */
async function trySpawn(input: { envId: string | null; driveId?: string | null }) {
  return spawnAgentSession({
    ownerId: payerId,
    driveId: input.driveId === undefined ? driveId : input.driveId,
    envId: input.envId,
    deps: {
      store: sessionStore,
      now: () => new Date(),
      maxActiveSessions: 1_000,
      // The REAL store, so the drive-agreement check reads a real row rather
      // than a fixture that could disagree with one.
      findEnv: async (id) => envStore.findById(id),
    },
  });
}

async function spawnInEnv(envId: string | null): Promise<AgentSessionRecord> {
  const spawned = await trySpawn({ envId });
  if (!spawned.ok) throw new Error(`spawn refused: ${spawned.reason}`);
  return spawned.session;
}

beforeAll(async () => {
  envStore = await createDbDriveEnvStore();
  sessionStore = await createDbAgentSessionStore();
  await db
    .insert(users)
    .values({ id: payerId, email: `env-ses-${payerId}@test.local`, name: 'Env Payer', updatedAt: new Date() })
    .onConflictDoNothing();
  await db
    .insert(drives)
    .values([
      { id: driveId, name: 'Env Drive', slug: `env-ses-drive-${driveId}`, ownerId: payerId, updatedAt: new Date() },
      {
        id: otherDriveId,
        name: 'Other Drive',
        slug: `env-ses-other-${otherDriveId}`,
        ownerId: payerId,
        updatedAt: new Date(),
      },
    ])
    .onConflictDoNothing();
});

async function wipe() {
  await db.delete(agentWorkspaces).where(eq(agentWorkspaces.ownerId, payerId));
  for (const drive of [driveId, otherDriveId]) {
    await db.delete(driveEnvs).where(eq(driveEnvs.driveId, drive));
  }
  if (sandboxIds.size > 0) {
    await db.delete(machineSpriteReclaims).where(inArray(machineSpriteReclaims.sandboxId, [...sandboxIds]));
  }
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await db.delete(drives).where(inArray(drives.id, [driveId, otherDriveId]));
  await db.delete(users).where(eq(users.id, payerId));
});

describe('binding a session to an environment', () => {
  it("given an env in ANOTHER drive, should refuse — against real rows, not a fixture", async () => {
    // The drive-agreement check is what stops a member from routing work into
    // a drive's shared filesystem through an authorization path that only ever
    // looked at THEIR drive. Both drives here are real and both envs exist, so
    // what is under test is the comparison rather than a lookup returning null.
    const foreignEnvId = await seedEnv(`foreign-${createId().slice(0, 8)}`, otherDriveId);

    expect(await trySpawn({ envId: foreignEnvId })).toEqual({ ok: false, reason: 'env_not_found' });
    expect(await sessionStore.list({ driveId })).toEqual([]);
  });

  it('given a GLOBAL-assistant spawn, should refuse an env — no session may hold an env without a drive', async () => {
    // `drive_envs.driveId` is NOT NULL, so this falls out of the same
    // comparison with no branch of its own — and the database forbids the row
    // outright via `agent_workspaces_env_needs_drive_check`.
    const envId = await seedEnv();
    expect(await trySpawn({ envId, driveId: null })).toEqual({ ok: false, reason: 'env_not_found' });
  });

  it('given a vanished env, should refuse rather than mint a row pointing at nothing', async () => {
    expect(await trySpawn({ envId: createId() })).toEqual({ ok: false, reason: 'env_not_found' });
  });
});

describe('a session inside an environment — provisioning', () => {
  it('given TWO sessions in ONE env, should resolve the SAME sandbox from ONE VM', async () => {
    const envId = await seedEnv();
    const envKey = deriveDriveEnvSpriteKey({ tenantId: payerId, envId, secret: SECRET });
    sandboxIds.add(envKey);
    const a = await spawnInEnv(envId);
    const b = await spawnInEnv(envId);
    const host = makeSpriteHost();

    const first = await ensureForSession(a, host);
    const second = await ensureForSession(b, host);

    expect(first).toEqual({ ok: true, sandboxId: envKey, resumed: false });
    // The SECOND session resumes what the first minted — same name, same disk.
    expect(second).toEqual({ ok: true, sandboxId: envKey, resumed: true });
    expect(host.calls.provision.map((call) => call.name)).toEqual([envKey]);

    // The pointer is on the ENV's row, and on NEITHER session's — which is what
    // `agent_workspaces_env_no_sprite_check` enforces and what makes "ending a
    // session must not kill the env" structural rather than remembered.
    const env = await envStore.findById(envId);
    expect(env!.sandboxId).toBe(envKey);
    for (const session of [a, b]) {
      const row = await sessionStore.findById(session.id);
      expect(row!.envId).toBe(envId);
      expect(row!.sandboxId).toBeNull();
      expect(row!.spriteKey).toBeNull();
      expect(row!.spriteInstanceId).toBeNull();
    }
  });

  it('given N sessions ensuring an unprovisioned env AT ONCE, should mint exactly ONE VM', async () => {
    // The lazy-provisioning race, against real Postgres: the identity CAS on
    // the env row is the only thing serializing these, and a second live VM
    // under one env is a billed machine nothing points at.
    const envId = await seedEnv();
    const envKey = deriveDriveEnvSpriteKey({ tenantId: payerId, envId, secret: SECRET });
    sandboxIds.add(envKey);
    const sessions = await Promise.all([spawnInEnv(envId), spawnInEnv(envId), spawnInEnv(envId), spawnInEnv(envId)]);
    // The fake host models the REAL Sprite contract the whole design leans on:
    // a name is a physical VM, and provisioning a name that already exists
    // hands back that same VM rather than a second one.
    const host = makeSpriteHost();

    const results = await Promise.all(sessions.map((session) => ensureForSession(session, host)));

    // Every caller got the same machine — the CAS losers RECONCILED onto the
    // winner's identity rather than killing what they found, which is the
    // difference between four sessions sharing a disk and three sessions
    // destroying it.
    for (const result of results) {
      expect(result.ok && result.sandboxId).toBe(envKey);
    }
    // ONE VM, under ONE name, and nobody's Sprite was left unreferenced.
    expect([...host.live.keys()]).toEqual([envKey]);
    expect(host.calls.kill).toEqual([]);
    expect(await db.select().from(machineSpriteReclaims).where(eq(machineSpriteReclaims.sandboxId, envKey))).toEqual([]);

    // The env row is the one place the pointer lives, and it agrees with the
    // live VM's instance — the ABA guard every later teardown keys on.
    const env = await envStore.findById(envId);
    expect(env!.sandboxId).toBe(envKey);
    expect(env!.spriteInstanceId).toBe(host.live.get(envKey)!.instanceId);
  });

  it('given TWO sessions in ONE env, should SEE EACH OTHER\'S FILES — the point of a shared environment', async () => {
    // The sandboxId matching is the mechanism; this is the thing users actually
    // asked for. It is asserted through the same door the tooling uses —
    // `host.attach(sandboxId)` — because `machine-fs`, `machine-diff`, the git
    // runners and the shell bridge are ALL handle-keyed. None of them learned
    // anything about environments, and this is why they did not have to: two
    // sessions that resolve one sandbox resolve one disk, by construction.
    const envId = await seedEnv();
    const envKey = deriveDriveEnvSpriteKey({ tenantId: payerId, envId, secret: SECRET });
    sandboxIds.add(envKey);
    const author = await spawnInEnv(envId);
    const reader = await spawnInEnv(envId);
    const host = makeSpriteHost();

    const authorSandbox = await ensureForSession(author, host);
    const readerSandbox = await ensureForSession(reader, host);
    expect(authorSandbox.ok && readerSandbox.ok).toBe(true);
    if (!authorSandbox.ok || !readerSandbox.ok) return;

    // One session writes...
    const authorHandle = await host.host.attach({ sandboxId: authorSandbox.sandboxId });
    await authorHandle!.writeFiles([{ path: '/home/user/notes.md', content: 'written by the first session' }]);

    // ...the other reads it back, having resolved its OWN handle from its OWN
    // session row. Nothing was threaded between them.
    const readerHandle = await host.host.attach({ sandboxId: readerSandbox.sandboxId });
    expect((await readerHandle!.readFile({ path: '/home/user/notes.md' }))?.toString()).toBe(
      'written by the first session',
    );
  });

  it('should hand each reader its OWN bytes — a read is a copy, as it is over a real wire', async () => {
    // Guards the FAKE, which the two assertions above lean on entirely. A real
    // handle's bytes cross a wire, so no caller can hold a reference into the
    // VM's disk; a fake that returned its stored buffer would let one session
    // mutate a file it merely read, and the next session would agree — a test
    // passing against a bug production cannot have.
    const envId = await seedEnv();
    const envKey = deriveDriveEnvSpriteKey({ tenantId: payerId, envId, secret: SECRET });
    sandboxIds.add(envKey);
    const host = makeSpriteHost();
    const provisioned = await ensureForSession(await spawnInEnv(envId), host);
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;

    const handle = await host.host.attach({ sandboxId: provisioned.sandboxId });
    await handle!.writeFiles([{ path: '/home/user/notes.md', content: 'original' }]);

    const first = await handle!.readFile({ path: '/home/user/notes.md' });
    first!.write('X', 0);

    expect((await handle!.readFile({ path: '/home/user/notes.md' }))?.toString()).toBe('original');
  });

  it('given a session in a DIFFERENT env, should NOT see those files — sharing is per environment, not global', async () => {
    // The other half of the claim. Two envs fold two Sprite names, so they are
    // two VMs and two disks; an env that leaked into its neighbour would be a
    // cross-tenant filesystem read, not a convenience.
    const [envId, otherEnvId] = [await seedEnv(), await seedEnv()];
    for (const id of [envId, otherEnvId]) {
      sandboxIds.add(deriveDriveEnvSpriteKey({ tenantId: payerId, envId: id, secret: SECRET }));
    }
    const host = makeSpriteHost();

    const inside = await ensureForSession(await spawnInEnv(envId), host);
    const outside = await ensureForSession(await spawnInEnv(otherEnvId), host);
    expect(inside.ok && outside.ok).toBe(true);
    if (!inside.ok || !outside.ok) return;
    expect(inside.sandboxId).not.toBe(outside.sandboxId);

    const insideHandle = await host.host.attach({ sandboxId: inside.sandboxId });
    await insideHandle!.writeFiles([{ path: '/home/user/secret.txt', content: 'private to this env' }]);

    const outsideHandle = await host.host.attach({ sandboxId: outside.sandboxId });
    expect(await outsideHandle!.readFile({ path: '/home/user/secret.txt' })).toBeNull();
  });

  it('given an env-bound session, should never mint a Sprite under the SESSION keyspace', async () => {
    // The failure this rules out is expensive and silent: a session-arm
    // provision mints a real VM under `agent-session-sprite:v2` and only THEN
    // fails the CHECK on the identity write, orphaning it.
    const envId = await seedEnv();
    const session = await spawnInEnv(envId);
    const envKey = deriveDriveEnvSpriteKey({ tenantId: payerId, envId, secret: SECRET });
    sandboxIds.add(envKey);
    const host = makeSpriteHost();

    await ensureForSession(session, host);

    expect([...host.live.keys()]).toEqual([envKey]);
    expect(host.calls.provision.every((call) => call.name.startsWith('pgs-env-'))).toBe(true);
  });
});

describe('a session inside an environment — ending it', () => {
  it('should stamp endedAt and leave the env\'s machine entirely alone', async () => {
    const envId = await seedEnv();
    const envKey = deriveDriveEnvSpriteKey({ tenantId: payerId, envId, secret: SECRET });
    sandboxIds.add(envKey);
    const a = await spawnInEnv(envId);
    const b = await spawnInEnv(envId);
    const host = makeSpriteHost();
    await ensureForSession(a, host);

    const ended = await endAgentSession({
      workspaceId: a.id,
      deps: { store: sessionStore, host: host.host, now: () => new Date() },
    });

    // No Sprite to tear down — the planner saw `sandboxId: null`, which is the
    // only state the CHECK permits this row to be in.
    expect(ended).toEqual({ ok: true, spriteTornDown: false });
    expect(host.calls.kill).toEqual([]);
    expect(host.live.has(envKey)).toBe(true);

    const endedRow = await sessionStore.findById(a.id);
    expect(endedRow!.endedAt).not.toBeNull();
    expect(endedRow!.teardownRequestedAt).toBeNull();
    expect(endedRow!.spriteTornDownAt).toBeNull();

    // The env's pointer is untouched, and the surviving session still resolves
    // the same machine and the same disk.
    const env = await envStore.findById(envId);
    expect(env!.sandboxId).toBe(envKey);
    expect(env!.teardownRequestedAt).toBeNull();
    expect(await ensureForSession(b, host)).toEqual({ ok: true, sandboxId: envKey, resumed: true });
  });
});

describe('a session inside an environment — deleting the environment', () => {
  it('should refuse while a session lives in it, killing nothing', async () => {
    const envId = await seedEnv();
    const envKey = deriveDriveEnvSpriteKey({ tenantId: payerId, envId, secret: SECRET });
    sandboxIds.add(envKey);
    const session = await spawnInEnv(envId);
    const host = makeSpriteHost();
    await ensureForSession(session, host);

    const deleted = await deleteDriveEnv({
      envId,
      force: false,
      deps: { store: envStore, host: host.host, now: () => new Date() },
    });

    expect(deleted).toEqual({ ok: false, reason: 'live_sessions', liveSessionCount: 1 });
    // Refused BEFORE the teardown, so the shared filesystem the session is
    // working in is still there.
    expect(host.calls.kill).toEqual([]);
    expect(host.live.has(envKey)).toBe(true);
    expect(await envStore.findById(envId)).not.toBeNull();
  });

  it('given every session in it has ENDED, should delete and tear the machine down', async () => {
    const envId = await seedEnv();
    const envKey = deriveDriveEnvSpriteKey({ tenantId: payerId, envId, secret: SECRET });
    sandboxIds.add(envKey);
    const session = await spawnInEnv(envId);
    const host = makeSpriteHost();
    await ensureForSession(session, host);
    await endAgentSession({
      workspaceId: session.id,
      deps: { store: sessionStore, host: host.host, now: () => new Date() },
    });

    const deleted = await deleteDriveEnv({
      envId,
      force: false,
      deps: { store: envStore, host: host.host, now: () => new Date() },
    });

    expect(deleted).toEqual({ ok: true, spriteTornDown: true });
    expect(host.live.has(envKey)).toBe(false);
    expect(await envStore.findById(envId)).toBeNull();
    // The session row went with the env (`envId` cascades), which is the whole
    // reason ended sessions do not block the delete.
    expect(await sessionStore.findById(session.id)).toBeNull();
  });
});

/**
 * The constraint NAME, dug out from under Drizzle's wrapper.
 *
 * `drizzle-orm` rethrows a driver error as a `DrizzleQueryError` whose message
 * is the SQL it tried, with the Postgres error hanging off `.cause` — so a test
 * that matched on the thrown message would pass against any failure at all,
 * including the wrong constraint. What is under test is WHICH rule refused.
 */
async function constraintViolatedBy(insert: Promise<unknown>): Promise<string | undefined> {
  try {
    await insert;
    return undefined;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      const constraint = (current as { constraint?: unknown }).constraint;
      if (typeof constraint === 'string') return constraint;
      current = (current as { cause?: unknown }).cause;
    }
    return undefined;
  }
}

describe('the database\'s own guard', () => {
  it('should REFUSE an env-bound session that also claims a Sprite', async () => {
    // `agent_workspaces_env_no_sprite_check`, stated where it can be violated:
    // two rows claiming one Sprite is what would make an ending session tear
    // down a shared filesystem. Everything above is only structural because
    // this insert cannot succeed.
    const envId = await seedEnv();
    const violated = await constraintViolatedBy(
      db.insert(agentWorkspaces).values({
        id: createId(),
        driveId,
        ownerId: payerId,
        envId,
        sandboxId: 'pgs-ses-illegal',
        updatedAt: new Date(),
      }),
    );
    expect(violated).toBe('agent_workspaces_env_no_sprite_check');
  });

  it('should REFUSE an env-bound session with no drive', async () => {
    // `agent_workspaces_env_needs_drive_check` — a row with an env and no drive
    // would route work into a drive's shared filesystem through an access path
    // that only ever reads `driveId`.
    const envId = await seedEnv();
    const violated = await constraintViolatedBy(
      db.insert(agentWorkspaces).values({
        id: createId(),
        driveId: null,
        ownerId: payerId,
        envId,
        updatedAt: new Date(),
      }),
    );
    expect(violated).toBe('agent_workspaces_env_needs_drive_check');
  });
});
