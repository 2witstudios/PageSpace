/**
 * The web tier's env WIRING — which store, which host, and which payer the
 * shared provisioning entry point is handed.
 *
 * What the deps THEMSELVES must be (the `drive-env-sprite:v1` keyspace, the
 * drive-owner tenant, the code-execution gate, what a refusal is called) is
 * pinned in `@pagespace/lib`'s own `env-provision-deps.test.ts`. It moved there
 * with the builder: three call sites across two processes share it now, and a
 * decision pinned in one app's suite would leave the other process free to
 * drift. What is left here is genuinely this app's: the payer lookup's
 * no-fallback rule, and that both entry points route through the ONE shared
 * verb rather than assembling a provision of their own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ENV_ID = 'env-1';
const DRIVE_ID = 'drive-1';
const DRIVE_OWNER_ID = 'owner-1';
const REQUESTER_ID = 'requester-9';

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
vi.mock('@pagespace/lib/services/drive-envs/drive-envs-store', () => ({
  createDbDriveEnvStore: async () => ({ findById: async () => envRow }),
}));
vi.mock('@/lib/agent-workspaces/sandbox-host-runtime', () => ({ getSandboxHost: async () => ({}) }));

/**
 * `rebuildDriveEnv` is replaced by a probe that does ONE thing: hand the
 * runtime's own `ensureSandbox` a row, which is exactly the call the real
 * service makes after a confirmed teardown. The service's ordering is covered
 * by its own suite; what is under test here is the call that builds.
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
 * Typed FROM THE REAL EXPORT, not from a hand-written shape: this suite exists
 * to catch drift in what the wiring hands the shared verb, and a locally
 * re-declared parameter type would leave these tests compiling green against a
 * contract that no longer exists.
 */
const ensureDriveEnvSandbox =
  vi.fn<(input: EnsureDriveEnvSandboxInput) => Promise<EnsureSpriteHolderSandboxResult>>(async () => ({
    ok: true,
    sandboxId: 'pgs-env-probe',
    resumed: false,
  }));
vi.mock('@pagespace/lib/services/drive-envs/env-provision-deps', () => ({
  ensureDriveEnvSandbox: (input: EnsureDriveEnvSandboxInput) => ensureDriveEnvSandbox(input),
}));

import type { EnsureSpriteHolderSandboxResult } from '@pagespace/lib/services/agent-workspaces/agent-workspace-sprite';
import type { ensureDriveEnvSandbox as ensureDriveEnvSandboxFn } from '@pagespace/lib/services/drive-envs/env-provision-deps';
import { ensureEnvSandboxForSession, rebuildEnv, resolveDriveEnvPayer } from '../drive-envs-runtime';
import { db } from '@pagespace/db/db';

type EnsureDriveEnvSandboxInput = Parameters<typeof ensureDriveEnvSandboxFn>[0];

function lastCall(): EnsureDriveEnvSandboxInput {
  const call = ensureDriveEnvSandbox.mock.calls.at(-1);
  if (!call) throw new Error('ensureDriveEnvSandbox was never called');
  return call[0];
}

function stubPayer(tier: string): void {
  vi.mocked(db.query.drives.findFirst).mockResolvedValue({ ownerId: DRIVE_OWNER_ID } as never);
  vi.mocked(db.query.users.findFirst).mockResolvedValue({ subscriptionTier: tier } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubPayer('pro');
});

describe('resolveDriveEnvPayer', () => {
  it("should resolve the DRIVE OWNER and their tier — the env's tenant and its bill", async () => {
    expect(await resolveDriveEnvPayer(DRIVE_ID)).toEqual({ payerId: DRIVE_OWNER_ID, tier: 'pro' });
  });

  it('given a vanished drive, should return null rather than fall back to anybody', async () => {
    // A fallback payer is not a lesser answer, it is a DIFFERENT Sprite name —
    // the tenant is part of the key fold — so this fails closed.
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined as never);
    expect(await resolveDriveEnvPayer(DRIVE_ID)).toBeNull();
  });
});

describe('ensureEnvSandboxForSession', () => {
  it("should route a session's ensure at the shared env verb, forwarding the intent unchanged", async () => {
    // The session's `reprovision` → `attach` translation happens upstream, in
    // `ensureAgentSessionSandbox`; this binding must not translate a second time.
    await ensureEnvSandboxForSession({ envId: ENV_ID, intent: 'attach', requesterId: REQUESTER_ID });

    expect(lastCall().envId).toBe(ENV_ID);
    expect(lastCall().intent).toBe('attach');
    expect(lastCall().requesterId).toBe(REQUESTER_ID);
    expect(lastCall().deps.resolvePayer).toBe(resolveDriveEnvPayer);
  });
});

describe('rebuildEnv', () => {
  it('should provision with the ENSURE intent — the same CAS every other provisioner runs', async () => {
    // `reprovision` would skip the probe and mint against a row the teardown
    // already cleared; the point of going through the one verb is that this
    // path is not special.
    await rebuildEnv({ envId: ENV_ID, requesterId: REQUESTER_ID });

    expect(lastCall().intent).toBe('ensure');
    expect(lastCall().envId).toBe(ENV_ID);
    expect(lastCall().requesterId).toBe(REQUESTER_ID);
  });
});
