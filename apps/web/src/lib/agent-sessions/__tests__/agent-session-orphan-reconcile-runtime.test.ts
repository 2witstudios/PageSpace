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
const mockSelect = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    delete: () => ({ where: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

vi.mock('./../agent-sessions-runtime', () => ({
  getSandboxHost: async () => ({ kill: (...args: unknown[]) => mockKill(...args) }),
  getAgentSessionStore: async () => ({
    stampSpriteTornDown: (...args: unknown[]) => mockStampSpriteTornDown(...args),
    findById: async () => null,
  }),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } },
}));

const { SandboxSpriteReplacedError } = await import('@pagespace/lib/services/sandbox/sandbox-host');
const { defaultReconcileAgentSessionOrphanSpritesDeps: deps, MAX_CANDIDATES_PER_TABLE } = await import(
  '../agent-session-orphan-reconcile-runtime'
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

  it('given the name now holds a DIFFERENT VM, should treat it as success rather than retry forever', async () => {
    // Our target is already gone — the outcome we wanted. The newcomer has its
    // own tracking row, so releasing ours never orphans it.
    mockKill.mockRejectedValueOnce(new SandboxSpriteReplacedError('sbx-1', 'i-old', 'i-new'));
    expect(await deps.killSprite({ sandboxId: 'sbx-1', spriteInstanceId: 'i-old' })).toEqual({ ok: true });
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

describe('markSessionTornDown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should stamp under the store CAS so a re-provisioned live VM is never marked dead', async () => {
    mockStampSpriteTornDown.mockResolvedValueOnce(true);

    const result = await deps.markSessionTornDown({
      sessionId: 'conv-1',
      sandboxId: 'sbx-1',
      spriteInstanceId: 'i-1',
    });

    expect(result).toBe(true);
    const [call] = mockStampSpriteTornDown.mock.calls;
    expect(call[0]).toMatchObject({ sessionId: 'conv-1', sandboxId: 'sbx-1', spriteInstanceId: 'i-1' });
    expect(call[0].stamps.spriteTornDownAt).toBeInstanceOf(Date);
  });

  it('given the CAS loses to a concurrent re-provision, should report false', async () => {
    mockStampSpriteTornDown.mockResolvedValueOnce(false);
    expect(
      await deps.markSessionTornDown({ sessionId: 'conv-1', sandboxId: 'sbx-1', spriteInstanceId: 'i-1' }),
    ).toBe(false);
  });
});

describe('listOrphanCandidates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should return both sources, tagged by kind', async () => {
    mockSelect
      .mockImplementationOnce(selectResolving([{ sandboxId: 'sbx-reclaim', spriteInstanceId: 'i-r' }]))
      .mockImplementationOnce(
        selectResolving([
          { sessionId: 'conv-1', sandboxId: 'sbx-session', spriteInstanceId: 'i-s', teardownRequestedAt: new Date() },
        ]),
      );

    const { rows, capped } = await deps.listOrphanCandidates();

    expect(capped).toBe(false);
    expect(rows).toEqual([
      { kind: 'reclaim', sandboxId: 'sbx-reclaim', spriteInstanceId: 'i-r' },
      { kind: 'agent-session', sessionId: 'conv-1', sandboxId: 'sbx-session', spriteInstanceId: 'i-s' },
    ]);
  });

  it('given the reclaim-outbox query fails, should still return the session candidates', async () => {
    // The two sources are independent; one degraded query must not park every
    // reclaim, because those are billing VMs nobody is using.
    mockSelect
      .mockImplementationOnce(selectRejecting('outbox unreachable'))
      .mockImplementationOnce(
        selectResolving([
          { sessionId: 'conv-1', sandboxId: 'sbx-session', spriteInstanceId: 'i-s', teardownRequestedAt: new Date() },
        ]),
      );

    const { rows } = await deps.listOrphanCandidates();

    expect(rows).toEqual([
      { kind: 'agent-session', sessionId: 'conv-1', sandboxId: 'sbx-session', spriteInstanceId: 'i-s' },
    ]);
  });

  it('given the session-row query fails, should still return the outbox candidates', async () => {
    mockSelect
      .mockImplementationOnce(selectResolving([{ sandboxId: 'sbx-reclaim', spriteInstanceId: null }]))
      .mockImplementationOnce(selectRejecting('sessions unreachable'));

    const { rows } = await deps.listOrphanCandidates();

    expect(rows).toEqual([{ kind: 'reclaim', sandboxId: 'sbx-reclaim', spriteInstanceId: null }]);
  });

  it('given more rows than the cap, should truncate and report the backlog', async () => {
    const overflow = Array.from({ length: MAX_CANDIDATES_PER_TABLE + 1 }, (_, i) => ({
      sandboxId: `sbx-${i}`,
      spriteInstanceId: null,
    }));
    mockSelect
      .mockImplementationOnce(selectResolving(overflow))
      .mockImplementationOnce(selectResolving([]));

    const { rows, capped } = await deps.listOrphanCandidates();

    expect(rows).toHaveLength(MAX_CANDIDATES_PER_TABLE);
    expect(capped).toBe(true);
  });
});
