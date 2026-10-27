import { describe, it, expect, beforeEach, vi } from 'vitest';

const { insertMock, updateMock, deleteMock, warnMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
  },
}));
vi.mock('@pagespace/db/schema/rate-limit-buckets', () => ({
  rateLimitBuckets: { key: 'key', windowStart: 'window_start', count: 'count', expiresAt: 'expires_at' },
}));
vi.mock('@pagespace/db/operators', () => ({
  sql: (...args: unknown[]) => ({ sql: args }),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  and: (...conds: unknown[]) => ({ and: conds }),
  lt: (a: unknown, b: unknown) => ({ lt: [a, b] }),
}));
vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: warnMock, error: vi.fn(), debug: vi.fn() },
  },
}));

import {
  deriveWebhookDeliveryId,
  claimWebhookDelivery,
  completeWebhookDelivery,
  releaseWebhookDelivery,
} from '../webhook-delivery-idempotency';
import { DEFAULT_REPLAY_WINDOW_MS } from '../webhook-signature';

// Kept in lockstep with the module's private constants; the SQL-level lease /
// reclaim behavior these feed is exercised for real against Postgres in
// webhook-delivery-idempotency.integration.test.ts.
const COMPLETED_SENTINEL_COUNT = 2 ** 30;
const PENDING_CLAIM_LEASE_MS = 60 * 1000;
const COMPLETED_TTL_MS = 2 * DEFAULT_REPLAY_WINDOW_MS;

// Build a chainable mock for db.insert(...).values(...).onConflictDoUpdate(...).returning()
// that captures the inserted row and returns the given post-upsert count.
function mockClaimReturning(count: number): { row: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  insertMock.mockReturnValue({
    values: (row: Record<string, unknown>) => {
      captured = row;
      return {
        onConflictDoUpdate: () => ({
          returning: async () => [{ count }],
        }),
      };
    },
  });
  return { row: () => captured };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deriveWebhookDeliveryId', () => {
  const base = { signature: 'v0=abc', timestamp: '1700000000' };

  it('is a constant-size hex digest of the signed material', () => {
    expect(deriveWebhookDeliveryId(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for identical signed bytes — a byte-identical replay maps to the same delivery', () => {
    expect(deriveWebhookDeliveryId({ ...base })).toBe(deriveWebhookDeliveryId({ ...base }));
  });

  it('differs for a re-signed retry (fresh timestamp/signature) — at-least-once semantics preserved', () => {
    const resigned = deriveWebhookDeliveryId({ signature: 'v0=other', timestamp: '1700000030' });
    expect(resigned).not.toBe(deriveWebhookDeliveryId(base));
  });
});

describe('claimWebhookDelivery', () => {
  it('claims a first-seen id (upsert count 1) with a namespaced key and a short PENDING lease — not the full dedup TTL', async () => {
    const { row } = mockClaimReturning(1);
    const before = Date.now();
    const verdict = await claimWebhookDelivery('wh-1', 'id-1');

    expect(verdict).toBe('claimed');
    expect(row().key).toBe('webhook-seen:wh-1:id-1');
    expect(row().count).toBe(1);
    // The insert carries the pending LEASE: long enough for any in-flight
    // delivery, short enough that an orphaned claim (dead process) frees up
    // well inside the 5-minute signature window.
    const expiresAt = (row().expiresAt as Date).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(PENDING_CLAIM_LEASE_MS - 1000);
    expect(expiresAt - before).toBeLessThan(DEFAULT_REPLAY_WINDOW_MS);
  });

  it('reports pending for an id whose first attempt has not completed (small count) — callers must answer retryable, never success', async () => {
    mockClaimReturning(2);
    await expect(claimWebhookDelivery('wh-1', 'id-1')).resolves.toBe('pending');
  });

  it('reports duplicate only for a COMPLETED delivery (count above the sentinel)', async () => {
    mockClaimReturning(COMPLETED_SENTINEL_COUNT + 1);
    await expect(claimWebhookDelivery('wh-1', 'id-1')).resolves.toBe('duplicate');
  });

  it('fails OPEN when the store is unreachable — delivery proceeds and the failure is logged', async () => {
    insertMock.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(claimWebhookDelivery('wh-1', 'id-1')).resolves.toBe('claimed');
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});

describe('completeWebhookDelivery', () => {
  it('flips the claim row to the completed sentinel AND extends it to the full dedup TTL (>= 2x the signature replay window)', async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    updateMock.mockReturnValue({ set: setMock });
    const before = Date.now();

    await completeWebhookDelivery('wh-1', 'id-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ count: COMPLETED_SENTINEL_COUNT })
    );
    const setArg = setMock.mock.calls[0][0] as { expiresAt: Date };
    expect(setArg.expiresAt.getTime() - before).toBeGreaterThanOrEqual(COMPLETED_TTL_MS - 1000);
    expect(whereMock).toHaveBeenCalledWith(
      expect.objectContaining({
        and: expect.arrayContaining([expect.objectContaining({ b: 'webhook-seen:wh-1:id-1' })]),
      })
    );
  });

  it('never throws when the store is unreachable — the claim stays pending (replays answer retryable, never double-deliver)', async () => {
    updateMock.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(completeWebhookDelivery('wh-1', 'id-1')).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});

describe('releaseWebhookDelivery', () => {
  it('deletes ONLY a pending claim row (count guarded below the sentinel) — a completed marker must survive a late release', async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    deleteMock.mockReturnValue({ where: whereMock });

    await releaseWebhookDelivery('wh-1', 'id-1');

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledWith(
      expect.objectContaining({
        and: expect.arrayContaining([
          expect.objectContaining({ b: 'webhook-seen:wh-1:id-1' }),
          expect.objectContaining({ lt: ['count', COMPLETED_SENTINEL_COUNT] }),
        ]),
      })
    );
  });

  it('never throws when the store is unreachable — the claim self-expires with its lease', async () => {
    deleteMock.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(releaseWebhookDelivery('wh-1', 'id-1')).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
