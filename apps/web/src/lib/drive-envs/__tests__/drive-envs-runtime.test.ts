/**
 * The env provisioning WIRING — the seams `ensureSpriteHolderSandbox` is handed.
 *
 * The provisioning core is deliberately holder-agnostic: it derives no Sprite
 * key, resolves no tenant, and picks no authorization gate of its own. Every one
 * of those is injected, which means the env's correctness on those axes lives
 * HERE, in ten lines of wiring, and nowhere else. Two of them are silent if
 * wrong:
 *
 *  - **The keyspace.** Session keys fold `agent-session-sprite:v2`, envs fold
 *    `drive-env-sprite:v1`. Wiring the session derivation here would put env
 *    names and session names in ONE keyspace, where an env could derive the name
 *    of a session Sprite still awaiting reclaim and provision straight onto a VM
 *    the reclaim outbox is about to kill. Nothing downstream would notice.
 *  - **The tenant.** The fold's tenant is the DRIVE OWNER. Using the requester
 *    would give one env two different Sprite identities depending on who
 *    rebuilt it — the same split `resolveSessionTenantId` fails closed to avoid.
 *
 * So this asserts what the wiring passes, not what the core does with it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ENV_ID = 'env-1';
const DRIVE_ID = 'drive-1';
const DRIVE_OWNER_ID = 'owner-1';
const REQUESTER_ID = 'requester-9';
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
};

vi.mock('@pagespace/db/db', () => ({
  db: { query: { drives: { findFirst: vi.fn() }, users: { findFirst: vi.fn() } } },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(() => ({})) }));
vi.mock('@pagespace/db/schema/core', () => ({ drives: {} }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/lib/services/sandbox/machine-session-manager', () => ({
  getSandboxSessionSecret: () => SECRET,
}));
vi.mock('@pagespace/lib/services/sandbox/network-options', () => ({
  resolveSandboxNetworkOptions: () => ({}),
}));
vi.mock('@pagespace/lib/services/sandbox/egress-ip', () => ({ getConfiguredEgressIpTag: () => undefined }));
vi.mock('@pagespace/lib/services/sandbox/containment', () => ({
  decideFullEgressEnablement: () => ({ ok: true }),
  isContainmentVerified: () => true,
}));
vi.mock('@pagespace/lib/services/sandbox/can-run-code', () => ({
  canRunCode: vi.fn(async () => ({ ok: true })),
  isCodeExecutionEnabled: () => true,
}));
vi.mock('@pagespace/lib/services/drive-envs/drive-envs-store', () => ({
  createDbDriveEnvStore: async () => ({}),
}));
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({ getSandboxHost: async () => ({}) }));

/**
 * `rebuildDriveEnv` is replaced by a probe that does ONE thing: hand the
 * runtime's own `ensureSandbox` a row, which is exactly the call the real
 * service makes after a confirmed teardown. The service's ordering is covered
 * by its own suite; what is under test here is the deps that call builds.
 */
vi.mock('@pagespace/lib/services/drive-envs/drive-envs', () => ({
  rebuildDriveEnv: vi.fn(async ({ deps }: { deps: { ensureSandbox: (row: unknown) => Promise<unknown> } }) => {
    await deps.ensureSandbox(envRow);
    return { ok: true, sandboxId: 'pgs-env-probe' };
  }),
  createDriveEnv: vi.fn(),
  listDriveEnvs: vi.fn(),
  renameDriveEnv: vi.fn(),
  deleteDriveEnv: vi.fn(),
  toDriveEnvDTO: vi.fn(),
}));

/**
 * Typed FROM THE REAL EXPORT, not from a hand-written shape.
 *
 * This suite exists to catch drift in what the wiring hands the provisioner, so
 * a locally re-declared deps type would defeat it in the one case that matters:
 * `SpriteHolderProvisionDeps` gaining or renaming a seam would leave these tests
 * compiling green against a contract that no longer exists (CodeRabbit's
 * nitpick, and it is right that a stale-but-compiling assertion is worse here
 * than elsewhere).
 */
const ensureSpriteHolderSandbox =
  vi.fn<(input: EnsureSpriteHolderInput) => Promise<EnsureSpriteHolderSandboxResult>>(async () => ({
    ok: true,
    sandboxId: 'pgs-env-probe',
    resumed: false,
  }));
vi.mock('@pagespace/lib/services/agent-workspaces/agent-workspace-sprite', () => ({
  ensureSpriteHolderSandbox: (input: EnsureSpriteHolderInput) => ensureSpriteHolderSandbox(input),
}));

import type {
  EnsureSpriteHolderSandboxResult,
  SpriteHolderProvisionDeps,
  SpriteHolderProvisionIntent,
} from '@pagespace/lib/services/agent-workspaces/agent-workspace-sprite';
import type { SpriteHolderLifecycleRow } from '@pagespace/lib/agent-workspaces/plan-workspace-lifecycle';
import type { SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { rebuildEnv } from '../drive-envs-runtime';

/** The core's own call shape — derived, so a change to it breaks this suite instead of sliding past. */
type EnsureSpriteHolderInput = {
  row: SpriteHolderLifecycleRow;
  intent: SpriteHolderProvisionIntent;
  deps: SpriteHolderProvisionDeps;
};
import { deriveDriveEnvSpriteKey } from '@pagespace/lib/drive-envs/env-sprite-key';
import { deriveAgentSessionSpriteKey } from '@pagespace/lib/agent-workspaces/workspace-sprite-key';
import { canRunCode } from '@pagespace/lib/services/sandbox/can-run-code';
import { db } from '@pagespace/db/db';

function lastProvisionCall(): EnsureSpriteHolderInput {
  const call = ensureSpriteHolderSandbox.mock.calls.at(-1);
  if (!call) throw new Error('ensureSpriteHolderSandbox was never called');
  return call[0];
}

function stubPayer(tier: SubscriptionTier): void {
  vi.mocked(db.query.drives.findFirst).mockResolvedValue({ ownerId: DRIVE_OWNER_ID } as never);
  vi.mocked(db.query.users.findFirst).mockResolvedValue({ subscriptionTier: tier } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubPayer('pro');
});

describe('rebuildEnv wiring', () => {
  it('should fold the Sprite key in the ENV keyspace, tenanted on the DRIVE OWNER', async () => {
    await rebuildEnv({ envId: ENV_ID, requesterId: REQUESTER_ID });

    const derived = lastProvisionCall().deps.deriveSpriteKey(ENV_ID);
    expect(derived).toBe(
      deriveDriveEnvSpriteKey({ tenantId: DRIVE_OWNER_ID, envId: ENV_ID, secret: SECRET }),
    );
    expect(derived.startsWith('pgs-env-')).toBe(true);
  });

  it('should NEVER derive a session name for an env — one keyspace would let an env land on a session VM awaiting reclaim', async () => {
    await rebuildEnv({ envId: ENV_ID, requesterId: REQUESTER_ID });

    const derived = lastProvisionCall().deps.deriveSpriteKey(ENV_ID);
    const sessionName = deriveAgentSessionSpriteKey({
      tenantId: DRIVE_OWNER_ID,
      workspaceId: ENV_ID,
      secret: SECRET,
    });
    expect(derived).not.toBe(sessionName);
  });

  it('should NOT tenant the fold on the requester — one env must not have two Sprite identities', async () => {
    await rebuildEnv({ envId: ENV_ID, requesterId: REQUESTER_ID });

    const derived = lastProvisionCall().deps.deriveSpriteKey(ENV_ID);
    expect(derived).not.toBe(
      deriveDriveEnvSpriteKey({ tenantId: REQUESTER_ID, envId: ENV_ID, secret: SECRET }),
    );
  });

  it('should authorize the REQUESTER against the env\'s drive, billed to the drive owner', async () => {
    await rebuildEnv({ envId: ENV_ID, requesterId: REQUESTER_ID });
    await lastProvisionCall().deps.authorize();

    expect(canRunCode).toHaveBeenCalledWith({
      userId: REQUESTER_ID,
      driveId: DRIVE_ID,
      ownerId: DRIVE_OWNER_ID,
      requestOrigin: 'user',
    });
  });

  it('should provision with the ENSURE intent — the same CAS every other provisioner runs', async () => {
    // `reprovision` would skip the probe and mint against a row the teardown
    // already cleared; the point of going through the one core is that this
    // path is not special.
    await rebuildEnv({ envId: ENV_ID, requesterId: REQUESTER_ID });
    expect(lastProvisionCall().intent).toBe('ensure');
    expect(lastProvisionCall().row.holderId).toBe(ENV_ID);
  });

  it('given a payer whose tier lost sandbox access, should refuse at the mint site', async () => {
    stubPayer('free');
    await rebuildEnv({ envId: ENV_ID, requesterId: REQUESTER_ID });

    const quota = await lastProvisionCall().deps.checkQuota({ alreadyProvisioned: false });
    expect(quota).toEqual({ allowed: false, denial: 'not_authorized', reason: 'tier_ineligible' });
  });

  it('given an eligible payer, should let the mint through — the env ALLOWANCE is metered at create, not here', async () => {
    const quota = await (async () => {
      await rebuildEnv({ envId: ENV_ID, requesterId: REQUESTER_ID });
      return lastProvisionCall().deps.checkQuota({ alreadyProvisioned: false });
    })();
    expect(quota).toEqual({ allowed: true });
  });

  it('given a vanished drive, should fail closed rather than fold under another tenant', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined as never);

    await rebuildEnv({ envId: ENV_ID, requesterId: REQUESTER_ID });

    expect(ensureSpriteHolderSandbox).not.toHaveBeenCalled();
  });
});
