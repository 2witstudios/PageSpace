import { describe, it, expect, beforeEach, vi } from 'vitest';

const { insertMock, deleteMock, warnMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  deleteMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: insertMock,
    delete: deleteMock,
  },
}));
vi.mock('@pagespace/db/schema/rate-limit-buckets', () => ({
  rateLimitBuckets: { key: 'key', windowStart: 'window_start', count: 'count', expiresAt: 'expires_at' },
}));
vi.mock('@pagespace/db/operators', () => ({
  sql: () => ({}),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  and: (...conds: unknown[]) => ({ and: conds }),
}));
vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: warnMock, error: vi.fn(), debug: vi.fn() },
  },
}));

import {
  deriveWebhookDeliveryId,
  claimWebhookDelivery,
  releaseWebhookDelivery,
} from '../webhook-delivery-idempotency';
import { DEFAULT_REPLAY_WINDOW_MS } from '../webhook-signature';

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

  it('is a constant-size hex digest regardless of input shape', () => {
    const fromHeader = deriveWebhookDeliveryId({ ...base, headerValue: 'delivery-1' });
    const fromFallback = deriveWebhookDeliveryId({ ...base, headerValue: null });
    expect(fromHeader).toMatch(/^[0-9a-f]{64}$/);
    expect(fromFallback).toMatch(/^[0-9a-f]{64}$/);
  });

  it('identifies by the client header when present: the same id maps to the same delivery across RE-SIGNED retries', () => {
    const first = deriveWebhookDeliveryId({ signature: 'v0=aaa', timestamp: '1700000000', headerValue: 'delivery-1' });
    const resigned = deriveWebhookDeliveryId({ signature: 'v0=bbb', timestamp: '1700000030', headerValue: 'delivery-1' });
    expect(resigned).toBe(first);
  });

  it('treats distinct header ids as distinct deliveries even for identical signed bytes', () => {
    const a = deriveWebhookDeliveryId({ ...base, headerValue: 'delivery-1' });
    const b = deriveWebhookDeliveryId({ ...base, headerValue: 'delivery-2' });
    expect(a).not.toBe(b);
  });

  it('falls back to the signature+timestamp pair when the header is absent or blank: identical bytes dedup, a re-signed retry does not', () => {
    const identical = deriveWebhookDeliveryId({ ...base, headerValue: null });
    const blankHeader = deriveWebhookDeliveryId({ ...base, headerValue: '   ' });
    const resigned = deriveWebhookDeliveryId({ signature: 'v0=other', timestamp: '1700000030', headerValue: null });
    expect(blankHeader).toBe(identical);
    expect(resigned).not.toBe(identical);
  });

  it('never collides a header-derived id with a fallback-derived one (domain-separated hashing)', () => {
    // A malicious header carrying the fallback's preimage must not claim the
    // same id the fallback would derive.
    const fallback = deriveWebhookDeliveryId({ ...base, headerValue: null });
    const mimic = deriveWebhookDeliveryId({ ...base, headerValue: `signature:${base.timestamp}:${base.signature}` });
    expect(mimic).not.toBe(fallback);
  });
});

describe('claimWebhookDelivery', () => {
  it('claims a first-seen id (upsert count 1) with a namespaced key and a TTL that outlives the signature replay window', async () => {
    const { row } = mockClaimReturning(1);
    const before = Date.now();
    const verdict = await claimWebhookDelivery('wh-1', 'id-1');

    expect(verdict).toBe('claimed');
    expect(row().key).toBe('webhook-seen:wh-1:id-1');
    expect(row().count).toBe(1);
    const expiresAt = (row().expiresAt as Date).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(DEFAULT_REPLAY_WINDOW_MS);
  });

  it('reports duplicate for an already-seen id (upsert count > 1)', async () => {
    mockClaimReturning(2);
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

describe('releaseWebhookDelivery', () => {
  it('deletes the claim row so a sender retry of a failed delivery is not swallowed as a duplicate', async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    deleteMock.mockReturnValue({ where: whereMock });

    await releaseWebhookDelivery('wh-1', 'id-1');

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledWith(
      expect.objectContaining({
        and: expect.arrayContaining([expect.objectContaining({ b: 'webhook-seen:wh-1:id-1' })]),
      })
    );
  });

  it('never throws when the store is unreachable — the claim self-expires with its TTL', async () => {
    deleteMock.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(releaseWebhookDelivery('wh-1', 'id-1')).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
