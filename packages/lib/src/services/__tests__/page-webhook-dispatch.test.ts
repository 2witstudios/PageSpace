import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Boundary-level fakes: the page-type lookup and lastFireError bookkeeping go
 * through the mocked db; the CHANNEL handler goes through the mocked
 * page-webhook-service (its own test covers the publish path).
 */
function makeChain(value: unknown) {
  const chain: Record<string, unknown> = {
    set: (...args: unknown[]) => {
      setCalls.push(args[0]);
      return chain;
    },
    where: () => chain,
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(value).then(resolve, reject),
    catch: (reject: (e: unknown) => void) => Promise.resolve(value).catch(reject),
  };
  return chain;
}

const setCalls: unknown[] = [];
const mockPageFindFirst = vi.fn();
const mockUpdate = vi.fn((..._args: unknown[]) => makeChain(undefined));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { pages: { findFirst: (...args: unknown[]) => mockPageFindFirst(...args) } },
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

vi.mock('@pagespace/db/schema/page-webhooks', () => ({
  pageWebhooks: { __name: 'page_webhooks', id: 'id' },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { __name: 'pages', id: 'id' },
}));

const mockPublish = vi.fn();
vi.mock('../page-webhook-service', () => ({
  publishWebhookMessage: (...args: unknown[]) => mockPublish(...args),
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
  setCalls.length = 0;
  mockPageFindFirst.mockResolvedValue({ type: 'CHANNEL' });
  mockPublish.mockResolvedValue({ ok: true });
});

describe('dispatchWebhookDelivery', () => {
  it('runs the CHANNEL handler for a channel page: publishes the envelope and reports handled', async () => {
    const result = await dispatchWebhookDelivery(DELIVERY);

    expect(result).toEqual({ kind: 'handled' });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('wh-1', { content: 'deploy done' });
  });

  it('propagates a CHANNEL handler failure verbatim so the route keeps its status mapping', async () => {
    for (const error of ['rate_limited', 'channel_not_found', 'internal_error', 'content must not be empty']) {
      mockPublish.mockResolvedValue({ ok: false, error });
      const result = await dispatchWebhookDelivery(DELIVERY);
      expect(result).toEqual({ kind: 'failed', error });
    }
  });

  it('reports no_action for a page type without a handler and records the error on the row', async () => {
    mockPageFindFirst.mockResolvedValue({ type: 'DOCUMENT' });

    const result = await dispatchWebhookDelivery(DELIVERY);

    expect(result).toEqual({ kind: 'no_action' });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(setCalls).toEqual([{ lastFireError: 'no action configured' }]);
  });

  it('reports no_action when the page row has vanished — the sender still gets its 202', async () => {
    mockPageFindFirst.mockResolvedValue(undefined);

    const result = await dispatchWebhookDelivery(DELIVERY);

    expect(result).toEqual({ kind: 'no_action' });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(setCalls).toEqual([{ lastFireError: 'no action configured' }]);
  });

  it('rejects a non-object envelope before any handler runs, and records the envelope error', async () => {
    for (const payload of [null, 'string', 42, [1, 2]]) {
      setCalls.length = 0;
      const result = await dispatchWebhookDelivery({ ...DELIVERY, payload });
      expect(result).toEqual({ kind: 'failed', error: 'payload must be a JSON object' });
      expect(setCalls).toEqual([{ lastFireError: 'payload must be a JSON object' }]);
    }
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockPageFindFirst).not.toHaveBeenCalled();
  });

  it('survives a bookkeeping write failure on the no-action path — still reports no_action', async () => {
    mockPageFindFirst.mockResolvedValue({ type: 'DOCUMENT' });
    mockUpdate.mockImplementation(() => {
      throw new Error('db down');
    });

    const result = await dispatchWebhookDelivery(DELIVERY);

    expect(result).toEqual({ kind: 'no_action' });
  });

  it('catches an unexpected page-lookup failure and reports internal_error, never throws', async () => {
    mockPageFindFirst.mockRejectedValue(new Error('db down'));

    const result = await dispatchWebhookDelivery(DELIVERY);

    expect(result).toEqual({ kind: 'failed', error: 'internal_error' });
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
