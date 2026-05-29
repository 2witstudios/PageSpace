// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((field: unknown, value: unknown) => ({ eq: [field, value] })),
}));

vi.mock('@pagespace/db/schema/zoom', () => ({
  zoomConnections: { zoomUserId: 'zoomUserId', zoomAccountId: 'zoomAccountId' },
}));

vi.mock('@pagespace/db/schema/webhook-triggers', () => ({
  webhookTriggers: {
    id: 'id',
    connectionId: 'connectionId',
    eventType: 'eventType',
    isEnabled: 'isEnabled',
  },
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      zoomConnections: { findFirst: vi.fn() },
      webhookTriggers: { findMany: vi.fn() },
    },
    update: vi.fn(),
  },
}));

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import {
  findZoomConnectionByHost,
  findMatchingWebhookTriggers,
  claimTriggerFired,
  setTriggerError,
} from '../webhook-trigger-queries';

const mockDb = db as unknown as {
  query: {
    zoomConnections: { findFirst: ReturnType<typeof vi.fn> };
    webhookTriggers: { findMany: ReturnType<typeof vi.fn> };
  };
  update: ReturnType<typeof vi.fn>;
};

// Builds a chainable update() mock and exposes the captured set() values.
const stubUpdate = (whereImpl: () => unknown) => {
  const setValues: Record<string, unknown>[] = [];
  const where = vi.fn(whereImpl);
  const set = vi.fn((values: Record<string, unknown>) => {
    setValues.push(values);
    return { where };
  });
  mockDb.update.mockReturnValue({ set });
  return { setValues, set, where };
};

const aConnection = () => ({
  id: 'conn_1',
  userId: 'user_1',
  zoomUserId: 'host_1',
  zoomAccountId: 'acct_1',
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findZoomConnectionByHost', () => {
  it('returns the connection when host_id + account_id match a row', async () => {
    const connection = aConnection();
    mockDb.query.zoomConnections.findFirst.mockResolvedValue(connection);

    const result = await findZoomConnectionByHost('host_1', 'acct_1');

    expect(result).toEqual({ success: true, data: connection });
  });

  it('returns a not-found error rather than throwing when no row matches', async () => {
    mockDb.query.zoomConnections.findFirst.mockResolvedValue(undefined);

    const result = await findZoomConnectionByHost('nope', 'acct_1');

    expect(result).toEqual({ success: false, error: 'Connection not found' });
  });

  it('surfaces a DB failure as data instead of throwing', async () => {
    mockDb.query.zoomConnections.findFirst.mockRejectedValue(new Error('db down'));

    const result = await findZoomConnectionByHost('host_1', 'acct_1');

    expect(result).toEqual({ success: false, error: 'db down' });
  });
});

describe('findMatchingWebhookTriggers', () => {
  it('returns matching triggers for a connection + event type', async () => {
    const triggers = [{ id: 't1' }, { id: 't2' }];
    mockDb.query.webhookTriggers.findMany.mockResolvedValue(triggers);

    const result = await findMatchingWebhookTriggers('conn_1', 'recording.transcript_completed');

    expect(result).toEqual({ success: true, data: triggers });
  });

  it('filters on isEnabled = true', async () => {
    mockDb.query.webhookTriggers.findMany.mockResolvedValue([]);

    await findMatchingWebhookTriggers('conn_1', 'meeting.ended');

    expect(eq).toHaveBeenCalledWith('isEnabled', true);
  });

  it('surfaces a DB failure as data instead of throwing', async () => {
    mockDb.query.webhookTriggers.findMany.mockRejectedValue(new Error('query failed'));

    const result = await findMatchingWebhookTriggers('conn_1', 'meeting.ended');

    expect(result).toEqual({ success: false, error: 'query failed' });
  });
});

describe('claimTriggerFired', () => {
  it('marks the trigger fired and clears any prior error', async () => {
    const { setValues } = stubUpdate(() => Promise.resolve());

    const result = await claimTriggerFired('t1');

    expect(result).toEqual({ success: true, data: undefined });
    expect(setValues[0].lastFiredAt).toBeInstanceOf(Date);
    expect(setValues[0].lastFireError).toBeNull();
  });

  it('surfaces a DB failure as data instead of throwing', async () => {
    stubUpdate(() => Promise.reject(new Error('write failed')));

    const result = await claimTriggerFired('t1');

    expect(result).toEqual({ success: false, error: 'write failed' });
  });
});

describe('setTriggerError', () => {
  it('records the error and leaves lastFiredAt untouched', async () => {
    const { setValues } = stubUpdate(() => Promise.resolve());

    const result = await setTriggerError('t1', 'workflow blew up');

    expect(result).toEqual({ success: true, data: undefined });
    expect(setValues[0]).toEqual({ lastFireError: 'workflow blew up' });
    expect(setValues[0]).not.toHaveProperty('lastFiredAt');
  });

  it('surfaces a DB failure as data instead of throwing', async () => {
    stubUpdate(() => Promise.reject(new Error('write failed')));

    const result = await setTriggerError('t1', 'workflow blew up');

    expect(result).toEqual({ success: false, error: 'write failed' });
  });
});
