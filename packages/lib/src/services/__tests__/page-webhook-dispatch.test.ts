import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Boundary-level fakes: the page-type lookup goes through the mocked db; the
 * CHANNEL handler and the lastFireError bookkeeping go through the mocked
 * page-webhook-service (its own test covers the publish path and
 * markWebhookFired's never-throws contract).
 */
const mockPageFindFirst = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { pages: { findFirst: (...args: unknown[]) => mockPageFindFirst(...args) } },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { __name: 'pages', id: 'id' },
}));

const mockPublish = vi.fn();
const mockMarkFired = vi.fn();
vi.mock('../page-webhook-service', () => ({
  publishWebhookMessage: (...args: unknown[]) => mockPublish(...args),
  markWebhookFired: (...args: unknown[]) => mockMarkFired(...args),
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    system: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

import { dispatchWebhookDelivery } from '../page-webhook-dispatch';

const DELIVERY = { webhookId: 'wh-1', pageId: 'page-1', payload: { content: 'deploy done' } };

beforeEach(() => {
  vi.clearAllMocks();
  mockPageFindFirst.mockResolvedValue({ type: 'CHANNEL', isTrashed: false });
  mockPublish.mockResolvedValue({ ok: true });
  mockMarkFired.mockResolvedValue(undefined);
});

describe('dispatchWebhookDelivery', () => {
  it('runs the CHANNEL handler for a channel page: publishes the envelope and reports handled', async () => {
    const result = await dispatchWebhookDelivery(DELIVERY);

    expect(result).toEqual({ kind: 'handled' });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('wh-1', { content: 'deploy done' });
    // The handler owns its own bookkeeping — the dispatcher must not double-write.
    expect(mockMarkFired).not.toHaveBeenCalled();
  });

  it('propagates a CHANNEL handler failure verbatim so the route keeps its status mapping', async () => {
    for (const error of ['rate_limited', 'channel_not_found', 'internal_error', 'content must not be empty']) {
      mockPublish.mockResolvedValue({ ok: false, error });
      const result = await dispatchWebhookDelivery(DELIVERY);
      expect(result).toEqual({ kind: 'failed', error });
    }
  });

  it('reports no_action for a page type without a handler and records the error on the row', async () => {
    mockPageFindFirst.mockResolvedValue({ type: 'DOCUMENT', isTrashed: false });

    const result = await dispatchWebhookDelivery(DELIVERY);

    expect(result).toEqual({ kind: 'no_action' });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockMarkFired).toHaveBeenCalledTimes(1);
    expect(mockMarkFired).toHaveBeenCalledWith('wh-1', 'no action configured');
  });

  it('reports not_found for a trashed target page — no write into the trash, no bookkeeping, indistinguishable from an unknown token', async () => {
    mockPageFindFirst.mockResolvedValue({ type: 'CHANNEL', isTrashed: true });

    const result = await dispatchWebhookDelivery(DELIVERY);

    expect(result).toEqual({ kind: 'failed', error: 'not_found' });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockMarkFired).not.toHaveBeenCalled();
  });

  it('reports not_found when the page row is gone entirely — same generic outcome as trashed', async () => {
    mockPageFindFirst.mockResolvedValue(undefined);

    const result = await dispatchWebhookDelivery(DELIVERY);

    expect(result).toEqual({ kind: 'failed', error: 'not_found' });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockMarkFired).not.toHaveBeenCalled();
  });

  it('rejects a trashed target even when the payload is invalid — the 404 wins so nothing is distinguishable', async () => {
    mockPageFindFirst.mockResolvedValue({ type: 'CHANNEL', isTrashed: true });

    const result = await dispatchWebhookDelivery({ ...DELIVERY, payload: null });

    expect(result).toEqual({ kind: 'failed', error: 'not_found' });
    expect(mockMarkFired).not.toHaveBeenCalled();
  });

  it('rejects a non-object envelope before any handler runs, and records the envelope error', async () => {
    for (const payload of [null, 'string', 42, [1, 2]]) {
      mockMarkFired.mockClear();
      const result = await dispatchWebhookDelivery({ ...DELIVERY, payload });
      expect(result).toEqual({ kind: 'failed', error: 'payload must be a JSON object' });
      expect(mockMarkFired).toHaveBeenCalledWith('wh-1', 'payload must be a JSON object');
    }
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('catches an unexpected page-lookup failure and reports internal_error, never throws', async () => {
    mockPageFindFirst.mockRejectedValue(new Error('db down'));

    const result = await dispatchWebhookDelivery(DELIVERY);

    expect(result).toEqual({ kind: 'failed', error: 'internal_error' });
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
