/**
 * The env provisioning WIRING — the seams `ensureSpriteHolderSandbox` is handed.
 *
 * The provisioning core is deliberately holder-agnostic: it derives no Sprite
 * key, resolves no tenant, and picks no authorization gate of its own. Every one
 * of those is injected, which means the env's correctness on those axes lives
 * HERE, in one small builder, and nowhere else. Two of them are silent if wrong:
 *
 *  - **The keyspace.** Session keys fold `agent-session-sprite:v2`, envs fold
 *    `drive-env-sprite:v1`. Wiring the session derivation here would put env
 *    names and session names in ONE keyspace, where an env could derive the name
 *    of a session Sprite still awaiting reclaim and provision straight onto a VM
 *    the reclaim outbox is about to kill. Nothing downstream would notice.
 *  - **The tenant.** The fold's tenant is the DRIVE OWNER. Using the requester
 *    would give one env two different Sprite identities depending on who touched
 *    it — the same split `resolveSessionTenantId` fails closed to avoid.
 *
 * These assertions used to live in `apps/web`, when the web app's rebuild verb
 * was the only caller. They moved here with the builder itself: there are three
 * callers now across two processes (rebuild, a web session's ensure, a realtime
 * shell's ensure), and pinning the decisions in one app's suite would leave the
 * other process free to drift.
 *
 * It asserts what the wiring PASSES, not what the core does with it — the core
 * has its own suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const canRunCode = vi.fn<(input: unknown) => Promise<{ ok: boolean; reason?: string }>>(async () => ({ ok: true }));
vi.mock('../../sandbox/can-run-code', () => ({
  canRunCode: (input: unknown) => canRunCode(input),
  isCodeExecutionEnabled: () => true,
}));

import { buildEnvProvisionDeps, ensureDriveEnvSandbox } from '../env-provision-deps';
import { deriveDriveEnvSpriteKey } from '../../../drive-envs/env-sprite-key';
import { deriveAgentSessionSpriteKey } from '../../../agent-workspaces/workspace-sprite-key';
import type { DriveEnvRecord } from '../drive-envs-store';
import type { SandboxHost } from '../../sandbox/sandbox-host';

const ENV_ID = 'env-1';
const DRIVE_ID = 'drive-1';
const DRIVE_OWNER_ID = 'owner-1';
const REQUESTER_ID = 'requester-9';
/** >= 32 chars — every key derivation refuses anything shorter. */
const SECRET = 'x'.repeat(40);

const envRow = {
  id: ENV_ID,
  driveId: DRIVE_ID,
  name: 'staging',
  createdBy: DRIVE_OWNER_ID,
  spriteKey: null,
  sandboxId: null,
  spriteInstanceId: null,
  egressPolicyToken: null,
  teardownRequestedAt: null,
  spriteTornDownAt: null,
  storageLastBilledAt: new Date(),
  storageMeasuredBytes: null,
  storageMeasuredAt: null,
  lastActiveAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies DriveEnvRecord;

const noopStore = {
  updateSpriteIdentity: vi.fn(async () => true),
  applyStamps: vi.fn(async () => true),
  reloadSpritePointer: vi.fn(async () => null),
  enqueueReclaim: vi.fn(async () => {}),
};

const noopHost = {} as SandboxHost;

function deps(tier: 'pro' | 'free' = 'pro') {
  return buildEnvProvisionDeps({
    row: envRow,
    payer: { payerId: DRIVE_OWNER_ID, tier },
    requesterId: REQUESTER_ID,
    store: noopStore,
    host: noopHost,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  canRunCode.mockResolvedValue({ ok: true });
  process.env.SANDBOX_SESSION_SECRET = SECRET;
});

describe('buildEnvProvisionDeps', () => {
  it('should fold the Sprite key in the ENV keyspace, tenanted on the DRIVE OWNER', () => {
    const derived = deps().deriveSpriteKey(ENV_ID);
    expect(derived).toBe(deriveDriveEnvSpriteKey({ tenantId: DRIVE_OWNER_ID, envId: ENV_ID, secret: SECRET }));
    expect(derived.startsWith('pgs-env-')).toBe(true);
  });

  it('should NEVER derive a session name for an env — one keyspace would let an env land on a session VM awaiting reclaim', () => {
    expect(deps().deriveSpriteKey(ENV_ID)).not.toBe(
      deriveAgentSessionSpriteKey({ tenantId: DRIVE_OWNER_ID, workspaceId: ENV_ID, secret: SECRET }),
    );
  });

  it('should NOT tenant the fold on the requester — one env must not have two Sprite identities', () => {
    expect(deps().deriveSpriteKey(ENV_ID)).not.toBe(
      deriveDriveEnvSpriteKey({ tenantId: REQUESTER_ID, envId: ENV_ID, secret: SECRET }),
    );
  });

  it("should authorize the REQUESTER against the env's drive, billed to the drive owner", async () => {
    await deps().authorize();

    expect(canRunCode).toHaveBeenCalledWith({
      userId: REQUESTER_ID,
      driveId: DRIVE_ID,
      ownerId: DRIVE_OWNER_ID,
      requestOrigin: 'user',
    });
  });

  it('given the actor may not run code here, should surface the refusal as the denial detail', async () => {
    canRunCode.mockResolvedValue({ ok: false, reason: 'not_a_member' });
    expect(await deps().authorize()).toEqual({ ok: false, reason: 'not_a_member' });
  });

  it('given a payer whose tier lost sandbox access, should refuse at the mint site', async () => {
    expect(await deps('free').checkQuota({ alreadyProvisioned: false })).toEqual({
      allowed: false,
      denial: 'not_authorized',
      reason: 'tier_ineligible',
    });
  });

  it('given an eligible payer, should let the mint through — the env ALLOWANCE is metered at create, not here', async () => {
    expect(await deps().checkQuota({ alreadyProvisioned: false })).toEqual({ allowed: true });
  });

  it('should address the store by envId — the adapter that makes an env a second holder of the ONE CAS', async () => {
    const stamps = { lastActiveAt: new Date() };
    await deps().store.applyStamps({ holderId: ENV_ID, stamps });
    expect(noopStore.applyStamps).toHaveBeenCalledWith({ envId: ENV_ID, stamps, cas: undefined });
  });
});

describe('ensureDriveEnvSandbox', () => {
  it('given a vanished env, should fail closed rather than provision something', async () => {
    const result = await ensureDriveEnvSandbox({
      envId: ENV_ID,
      intent: 'ensure',
      requesterId: REQUESTER_ID,
      deps: {
        store: { ...noopStore, findById: async () => null },
        host: noopHost,
        resolvePayer: async () => ({ payerId: DRIVE_OWNER_ID, tier: 'pro' }),
      },
    });

    expect(result).toEqual({ ok: false, reason: 'provision_failed', detail: 'env_not_found' });
  });

  it('given a vanished DRIVE, should fail closed rather than fold under another tenant', async () => {
    // A fallback payer would derive a different Sprite NAME for this env, which
    // is a second machine, not a second guess.
    let resolved = 0;
    const result = await ensureDriveEnvSandbox({
      envId: ENV_ID,
      intent: 'ensure',
      requesterId: REQUESTER_ID,
      deps: {
        store: { ...noopStore, findById: async () => envRow },
        host: noopHost,
        resolvePayer: async () => {
          resolved += 1;
          return null;
        },
      },
    });

    expect(resolved).toBe(1);
    expect(result).toEqual({ ok: false, reason: 'provision_failed', detail: 'drive_not_found' });
  });
});
