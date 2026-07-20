import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Boundary-level fakes: the page_webhooks lookup/update goes through the
 * mocked db, the message insert/load goes through the mocked
 * channelMessageRepository (already a clean seam — no drizzle chains to fake
 * for the message path).
 */
function makeChain(value: unknown) {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    set: () => chain,
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(value).then(resolve, reject),
    catch: (reject: (e: unknown) => void) => Promise.resolve(value).catch(reject),
  };
  return chain;
}

const mockFindFirst = vi.fn();
const mockUpdate = vi.fn((..._args: unknown[]) => makeChain(undefined));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { pageWebhooks: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

vi.mock('@pagespace/db/schema/page-webhooks', () => ({
  pageWebhooks: { __name: 'page_webhooks', id: 'id' },
  SYSTEM_WEBHOOKS_USER_ID: 'system-webhooks',
}));

const mockInsertChannelMessage = vi.fn();
const mockLoadChannelMessageWithRelations = vi.fn().mockResolvedValue({ id: 'loaded' });
vi.mock('../channel-message-repository', () => ({
  channelMessageRepository: {
    insertChannelMessageWithAttachment: (...args: unknown[]) => mockInsertChannelMessage(...args),
    loadChannelMessageWithRelations: (...args: unknown[]) => mockLoadChannelMessageWithRelations(...args),
  },
}));

const mockCheckRateLimit = vi.fn();
vi.mock('../../security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: {
    PAGE_WEBHOOK: { maxAttempts: 30, windowMs: 60 * 1000, blockDurationMs: 60 * 1000, progressiveDelay: false },
  },
}));

vi.mock('../../auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: () => ({ 'x-signed': 'yes' }),
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    system: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

import { publishWebhookMessage } from '../page-webhook-service';

const WEBHOOK_ROW = {
  id: 'wh-1',
  pageId: 'page-1',
  name: 'Deploys',
  webhookToken: 'tok-abc',
  webhookSecretEncrypted: 'enc',
  isEnabled: true,
  createdBy: 'user-1',
};

const mockFetch = vi.fn().mockResolvedValue({ ok: true });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindFirst.mockResolvedValue(WEBHOOK_ROW);
  mockCheckRateLimit.mockResolvedValue({ allowed: true });
  mockInsertChannelMessage.mockResolvedValue({ kind: 'ok', message: { id: 'msg-1' } });
  mockLoadChannelMessageWithRelations.mockResolvedValue({ id: 'msg-1', content: 'hi' });
  vi.stubGlobal('fetch', mockFetch);
  vi.stubEnv('INTERNAL_REALTIME_URL', 'http://realtime.internal');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('publishWebhookMessage', () => {
  it('happy path: inserts the message as the system webhook user with the webhook name as sender, broadcasts, marks fired', async () => {
    const result = await publishWebhookMessage('wh-1', { content: 'deploy done' });

    expect(result).toEqual({ ok: true });
    expect(mockInsertChannelMessage).toHaveBeenCalledWith({
      pageId: 'page-1',
      userId: 'system-webhooks',
      content: 'deploy done',
      fileId: null,
      attachmentMeta: null,
      aiMeta: { senderType: 'webhook', senderName: 'Deploys' },
    });
    // Broadcasts the fully-loaded message over the signed realtime path.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://realtime.internal/api/broadcast');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      channelId: 'page-1',
      event: 'new_message',
    });
    // lastFiredAt updated, lastFireError cleared.
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('a payload username overrides the webhook configured name as the sender', async () => {
    await publishWebhookMessage('wh-1', { content: 'hi', username: 'CI Bot' });
    expect(mockInsertChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ aiMeta: { senderType: 'webhook', senderName: 'CI Bot' } }),
    );
  });

  it('a missing webhook no-ops: no insert, no broadcast', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const result = await publishWebhookMessage('wh-missing', { content: 'hi' });
    expect(result).toEqual({ ok: false, error: 'not_found' });
    expect(mockInsertChannelMessage).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a disabled webhook no-ops: no insert, no broadcast', async () => {
    mockFindFirst.mockResolvedValue({ ...WEBHOOK_ROW, isEnabled: false });
    const result = await publishWebhookMessage('wh-1', { content: 'hi' });
    expect(result).toEqual({ ok: false, error: 'not_found' });
    expect(mockInsertChannelMessage).not.toHaveBeenCalled();
  });

  it('an invalid payload does not insert and surfaces the core validation error', async () => {
    const result = await publishWebhookMessage('wh-1', { content: '   ' });
    expect(result).toEqual({ ok: false, error: 'content must not be empty' });
    expect(mockInsertChannelMessage).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('a rate-limited call does not insert and returns rate_limited', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false });
    const result = await publishWebhookMessage('wh-1', { content: 'hi' });
    expect(result).toEqual({ ok: false, error: 'rate_limited' });
    expect(mockCheckRateLimit).toHaveBeenCalledWith('page-webhook:wh-1', expect.objectContaining({ maxAttempts: 30 }));
    expect(mockInsertChannelMessage).not.toHaveBeenCalled();
  });

  it('a vanished channel page (insert reports not_found) returns channel_not_found without broadcasting', async () => {
    mockInsertChannelMessage.mockResolvedValue({ kind: 'not_found' });
    const result = await publishWebhookMessage('wh-1', { content: 'hi' });
    expect(result).toEqual({ ok: false, error: 'channel_not_found' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a broadcast failure is swallowed — the message is persisted, so the publish still succeeds', async () => {
    mockFetch.mockRejectedValue(new Error('realtime down'));
    const result = await publishWebhookMessage('wh-1', { content: 'hi' });
    expect(result).toEqual({ ok: true });
    expect(mockInsertChannelMessage).toHaveBeenCalledTimes(1);
  });

  it('an unexpected db failure is caught and returned as internal_error, never thrown', async () => {
    mockFindFirst.mockRejectedValue(new Error('db down'));
    const result = await publishWebhookMessage('wh-1', { content: 'hi' });
    expect(result).toEqual({ ok: false, error: 'internal_error' });
  });
});
