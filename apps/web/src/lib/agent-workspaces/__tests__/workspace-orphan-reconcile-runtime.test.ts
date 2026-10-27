/**
 * The orphan-reconcile runtime binding — the deps that actually DESTROY VMs.
 *
 * Its pure core (`sprite-orphan-reconcile.ts`) is exhaustively tested, but the
 * binding is where the destructive calls live, and it carries real decisions of
 * its own: which failures count as a successful kill, and whether one failing
 * candidate query may silence the other. Its predecessor
 * (`machine-orphan-reconcile-runtime.ts`) had coverage here; this restores it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockKill = vi.fn();
const mockStampSpriteTornDown = vi.fn();
const mockEnqueueReclaim = vi.fn();
const mockSelect = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    delete: () => ({ where: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

vi.mock('./../sandbox-host-runtime', () => ({
  getSandboxHost: async () => ({ kill: (...args: unknown[]) => mockKill(...args) }),
}));

vi.mock('./../agent-workspaces-runtime', () => ({
  getAgentSessionStore: async () => ({
    stampSpriteTornDown: (...args: unknown[]) => mockStampSpriteTornDown(...args),
    enqueueReclaim: (...args: unknown[]) => mockEnqueueReclaim(...args),
    findById: async () => null,
  }),
}));

// Typed FROM the real store, so a change to either method's shape fails this
// file's typecheck rather than leaving an obsolete call shape passing.
type DriveEnvStore = Awaited<
  ReturnType<typeof import('@pagespace/lib/services/drive-envs/drive-envs-store').createDbDriveEnvStore>
>;
type DriveEnvRecord = NonNullable<Awaited<ReturnType<DriveEnvStore['findById']>>>;
const mockEnvStampSpriteTornDown = vi.fn<DriveEnvStore['stampSpriteTornDown']>();
const mockEnvFindById = vi.fn<DriveEnvStore['findById']>();
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({
  getDriveEnvStore: async () => ({
    stampSpriteTornDown: mockEnvStampSpriteTornDown,
    findById: mockEnvFindById,
  }),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } },
}));

const { SandboxSpriteReplacedError } = await import('@pagespace/lib/services/sandbox/sandbox-host');
const { defaultReconcileAgentSessionOrphanSpritesDeps: deps, MAX_CANDIDATES_PER_TABLE } = await import(
  '../workspace-orphan-reconcile-runtime'
);

/** A chainable Drizzle-ish select stub resolving to `rows`. */
function selectResolving(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy']) {
    chain[method] = () => chain;
  }
  chain.limit = async () => rows;
  return () => chain;
}

function selectRejecting(message: string) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy']) {
    chain[method] = () => chain;
  }
  chain.limit = async () => { throw new Error(message); };
  return () => chain;
}

describe('killSprite', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given a confirmed kill, should report ok', async () => {
    mockKill.mockResolvedValueOnce(undefined);
    expect(await deps.killSprite({ sandboxId: 'sbx-1', spriteInstanceId: 'i-1' })).toEqual({ ok: true });
    expect(mockKill).toHaveBeenCalledWith({ sandboxId: 'sbx-1', expectedInstanceId: 'i-1' });
  });

  it('given the name now holds a DIFFERENT VM, should report the replacement rather than collapsing to success', async () => {
    // #2254: which VM the replacement means "gone" for is a per-row-kind
    // decision the PURE module makes, not this binding — collapsing straight to
    // `{ ok: true }` here is what let a `reclaim` row's replaced-instance
    // refusal delete its outbox pointer and orphan the live VM.
    mockKill.mockRejectedValueOnce(new SandboxSpriteReplacedError('sbx-1', 'i-old', 'i-new'));
    expect(await deps.killSprite({ sandboxId: 'sbx-1', spriteInstanceId: 'i-old' })).toEqual({
      ok: 'replaced',
      actualInstanceId: 'i-new',
    });
  });

  it('given a genuine kill failure, should report it so the row stays queued for a later tick', async () => {
    const error = new Error('provider unreachable');
    mockKill.mockRejectedValueOnce(error);
    expect(await deps.killSprite({ sandboxId: 'sbx-1', spriteInstanceId: null })).toEqual({ ok: false, error });
  });

  it('given no known instance, should not pin the kill to one', async () => {
    mockKill.mockResolvedValueOnce(undefined);
    await deps.killSprite({ sandboxId: 'sbx-1', spriteInstanceId: null });
    expect(mockKill).toHaveBeenCalledWith({ sandboxId: 'sbx-1', expectedInstanceId: undefined });
  });
});

describe('markHolderTornDown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should stamp under the store CAS so a re-provisioned live VM is never marked dead', async () => {
    mockStampSpriteTornDown.mockResolvedValueOnce(true);

    const result = await deps.markHolderTornDown({
      kind: 'agent-session',
      workspaceId: 'conv-1',
      sandboxId: 'sbx-1',
      spriteInstanceId: 'i-1',
    });

    expect(result).toBe(true);
    const [call] = mockStampSpriteTornDown.mock.calls;
    expect(call[0]).toMatchObject({ workspaceId: 'conv-1', sandboxId: 'sbx-1', spriteInstanceId: 'i-1' });
    expect(call[0].stamps.spriteTornDownAt).toBeInstanceOf(Date);
  });

  it('given a drive-env row, should stamp the ENV store under the same instance CAS', async () => {
    // The one place this cron knows there are two holder tables. An env row
    // stamped through the SESSION store would silently no-op — a live VM left
    // billing with a teardown request nothing ever clears.
    mockEnvStampSpriteTornDown.mockResolvedValueOnce(true);

    const result = await deps.markHolderTornDown({
      kind: 'drive-env',
      envId: 'env-1',
      sandboxId: 'pgs-env-1',
      spriteInstanceId: 'i-1',
    });

    expect(result).toBe(true);
    expect(mockStampSpriteTornDown).not.toHaveBeenCalled();
    const [call] = mockEnvStampSpriteTornDown.mock.calls;
    expect(call[0]).toMatchObject({ envId: 'env-1', sandboxId: 'pgs-env-1', spriteInstanceId: 'i-1' });
    expect(call[0].stamps.spriteTornDownAt).toBeInstanceOf(Date);
  });

  it('given the CAS loses to a concurrent re-provision, should report false', async () => {
    mockStampSpriteTornDown.mockResolvedValueOnce(false);
    expect(
      await deps.markHolderTornDown({
        kind: 'agent-session',
        workspaceId: 'conv-1',
        sandboxId: 'sbx-1',
        spriteInstanceId: 'i-1',
      }),
    ).toBe(false);
  });
});

describe('chaseReclaimInstance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should re-point the outbox row at the live instance via the store upsert, not delete it', async () => {
    mockEnqueueReclaim.mockResolvedValueOnce(undefined);

    await deps.chaseReclaimInstance({ sandboxId: 'sbx-1', actualInstanceId: 'i-new' });

    expect(mockEnqueueReclaim).toHaveBeenCalledWith({ sandboxId: 'sbx-1', spriteInstanceId: 'i-new' });
  });
});

describe('isTeardownStillRequested', () => {
  beforeEach(() => vi.clearAllMocks());

  /** A whole `drive_envs` row — the shape `findById` really answers with. */
  function envRecord(over: Partial<DriveEnvRecord> = {}): DriveEnvRecord {
    return {
      id: 'env-1',
      driveId: 'drive-1',
      substrate: 'sprite',
      name: 'staging',
      createdBy: null,
      spriteKey: null,
      sandboxId: 'pgs-env-1',
      spriteInstanceId: 'i-1',
      egressPolicyToken: null,
      teardownRequestedAt: null,
      spriteTornDownAt: null,
      storageLastBilledAt: new Date(),
      storageMeasuredBytes: null,
      storageMeasuredAt: null,
      lastActiveAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
  }

  it('given a drive-env row, should re-read the ENV row rather than look for a session that does not exist', async () => {
    mockEnvFindById.mockResolvedValueOnce(envRecord({ teardownRequestedAt: new Date() }));
    expect(
      await deps.isTeardownStillRequested({
        kind: 'drive-env',
        envId: 'env-1',
        sandboxId: 'pgs-env-1',
        spriteInstanceId: 'i-1',
      }),
    ).toBe(true);
  });

  it('given an env REVIVED since listing, should refuse the kill', async () => {
    // A session opening in this environment re-provisions it and clears the
    // intent. Destroying that filesystem is the one irreversible mistake here —
    // and it is SHARED, so worse for an env than for a session.
    mockEnvFindById.mockResolvedValueOnce(envRecord({ teardownRequestedAt: null }));
    expect(
      await deps.isTeardownStillRequested({
        kind: 'drive-env',
        envId: 'env-1',
        sandboxId: 'pgs-env-1',
        spriteInstanceId: 'i-1',
      }),
    ).toBe(false);
  });

  it('given a vanished env row, should refuse the kill — the AFTER DELETE trigger owns that pointer now', async () => {
    mockEnvFindById.mockResolvedValueOnce(null);
    expect(
      await deps.isTeardownStillRequested({
        kind: 'drive-env',
        envId: 'env-1',
        sandboxId: 'pgs-env-1',
        spriteInstanceId: 'i-1',
      }),
    ).toBe(false);
  });
});

describe('listOrphanCandidates', () => {
  beforeEach(() => vi.clearAllMocks());

  const reclaimRow = { sandboxId: 'sbx-reclaim', spriteInstanceId: 'i-r' };
  const sessionRow = {
    workspaceId: 'conv-1',
    sandboxId: 'sbx-session',
    spriteInstanceId: 'i-s',
    teardownRequestedAt: new Date(),
  };
  const envRow = {
    envId: 'env-1',
    sandboxId: 'pgs-env-1',
    spriteInstanceId: 'i-e',
    teardownRequestedAt: new Date(),
  };

  /** The three sources, in the order `Promise.allSettled` receives them. */
  function stubSources(reclaim: unknown, session: unknown, env: unknown) {
    mockSelect
      .mockImplementationOnce(reclaim as () => unknown)
      .mockImplementationOnce(session as () => unknown)
      .mockImplementationOnce(env as () => unknown);
  }

  it('should return all THREE sources, tagged by kind', async () => {
    // The env source is the whole point of the fold: before it, a `drive_envs`
    // row whose kill failed was retried only by the next delete, rebuild or
    // ensure — which is to say, by a person.
    stubSources(selectResolving([reclaimRow]), selectResolving([sessionRow]), selectResolving([envRow]));

    const { rows, capped, incomplete } = await deps.listOrphanCandidates();

    expect(capped).toBe(false);
    expect(incomplete).toBe(false);
    expect(rows).toEqual([
      { kind: 'reclaim', sandboxId: 'sbx-reclaim', spriteInstanceId: 'i-r' },
      { kind: 'agent-session', workspaceId: 'conv-1', sandboxId: 'sbx-session', spriteInstanceId: 'i-s' },
      { kind: 'drive-env', envId: 'env-1', sandboxId: 'pgs-env-1', spriteInstanceId: 'i-e' },
    ]);
  });

  it('given the reclaim-outbox query fails, should still return the other candidates', async () => {
    // The sources are independent; one degraded query must not park every
    // reclaim, because those are billing VMs nobody is using.
    stubSources(selectRejecting('outbox unreachable'), selectResolving([sessionRow]), selectResolving([envRow]));

    const { rows, incomplete } = await deps.listOrphanCandidates();

    expect(rows.map((row) => row.kind)).toEqual(['agent-session', 'drive-env']);
    // Reported, not swallowed: a source that fails every tick would otherwise
    // produce a clean-looking run while its Sprites bill indefinitely.
    expect(incomplete).toBe(true);
  });

  it('given the session-row query fails, should still return the other candidates', async () => {
    stubSources(selectResolving([reclaimRow]), selectRejecting('sessions unreachable'), selectResolving([envRow]));

    const { rows, incomplete } = await deps.listOrphanCandidates();

    expect(rows.map((row) => row.kind)).toEqual(['reclaim', 'drive-env']);
    expect(incomplete).toBe(true);
  });

  it('given the drive-env query fails, should still return the other candidates', async () => {
    stubSources(selectResolving([reclaimRow]), selectResolving([sessionRow]), selectRejecting('envs unreachable'));

    const { rows, incomplete } = await deps.listOrphanCandidates();

    expect(rows.map((row) => row.kind)).toEqual(['reclaim', 'agent-session']);
    expect(incomplete).toBe(true);
  });

  it('given more rows than the cap in ANY source, should truncate and report the backlog', async () => {
    const overflow = Array.from({ length: MAX_CANDIDATES_PER_TABLE + 1 }, (_, i) => ({
      envId: `env-${i}`,
      sandboxId: `pgs-env-${i}`,
      spriteInstanceId: null,
      teardownRequestedAt: new Date(),
    }));
    stubSources(selectResolving([]), selectResolving([]), selectResolving(overflow));

    const { rows, capped } = await deps.listOrphanCandidates();

    expect(rows).toHaveLength(MAX_CANDIDATES_PER_TABLE);
    expect(capped).toBe(true);
  });
});
