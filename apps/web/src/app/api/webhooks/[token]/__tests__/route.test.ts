import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

const SECRET = 'test-webhook-secret';
const WEBHOOK = {
  id: 'wh-1',
  pageId: 'page-1',
  name: 'Deploys',
  isEnabled: true,
  webhookToken: 'tok-abc',
  webhookSecretEncrypted: 'encrypted-form-of-secret',
};

function makeChain(value: unknown) {
  const chain: Record<string, unknown> = {
    set: () => chain,
    where: () => chain,
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(value).then(resolve, reject),
    catch: (reject: (e: unknown) => void) => Promise.resolve(value).catch(reject),
  };
  return chain;
}

const mockFindFirst = vi.fn();
const mockPageFindFirst = vi.fn();
const mockUpdate = vi.fn((..._args: unknown[]) => makeChain(undefined));
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pageWebhooks: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
      pages: { findFirst: (...args: unknown[]) => mockPageFindFirst(...args) },
    },
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: (a: unknown, b: unknown) => ({ a, b }) }));
vi.mock('@pagespace/db/schema/page-webhooks', () => ({
  pageWebhooks: { id: 'pageWebhooks.id', webhookToken: 'pageWebhooks.webhookToken' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id' },
}));

// Real decrypt-equivalent for the test: returns the plaintext secret directly,
// so the route's HMAC verification runs against a known value.
vi.mock('@pagespace/lib/encryption/field-crypto', () => ({
  decryptField: vi.fn(async (v: string) => (v === WEBHOOK.webhookSecretEncrypted ? SECRET : v)),
}));

const mockPublish = vi.fn();
vi.mock('@pagespace/lib/services/page-webhook-service', () => ({
  publishWebhookMessage: (...args: unknown[]) => mockPublish(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { POST } from '../route';

function sign(body: string, timestamp: string, secret = SECRET): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

function makeRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/webhooks/tok-abc', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function signedRequest(body: string): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return makeRequest(body, {
    'x-pagespace-signature': sign(body, timestamp),
    'x-pagespace-timestamp': timestamp,
  });
}

const VALID_PAYLOAD = JSON.stringify({ content: 'deploy finished' });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindFirst.mockResolvedValue(WEBHOOK);
  mockPageFindFirst.mockResolvedValue({ type: 'CHANNEL' });
  mockPublish.mockResolvedValue({ ok: true });
});

describe('POST /api/webhooks/[token]', () => {
  it('accepts a validly signed request and publishes to the resolved webhook', async () => {
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });

    expect(response.status).toBe(200);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [webhookId, payload] = mockPublish.mock.calls[0];
    expect(webhookId).toBe('wh-1');
    expect(payload).toEqual({ content: 'deploy finished' });
  });

  it('rejects a body over 64KB with 413 before any lookup or parse', async () => {
    const oversized = JSON.stringify({ content: 'x'.repeat(64 * 1024) });
    const response = await POST(signedRequest(oversized), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(413);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('accepts a body exactly at the 64KB cap', async () => {
    // Total JSON body of exactly 65536 bytes: {"content":"…"} wrapper is 14 bytes.
    const atCap = JSON.stringify({ content: 'x'.repeat(64 * 1024 - 14) });
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(64 * 1024);
    const response = await POST(signedRequest(atCap), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).not.toBe(413);
  });

  it('rejects a request with no signature', async () => {
    const response = await POST(makeRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(403);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects a request signed with the wrong secret', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const request = makeRequest(VALID_PAYLOAD, {
      'x-pagespace-signature': sign(VALID_PAYLOAD, timestamp, 'wrong-secret'),
      'x-pagespace-timestamp': timestamp,
    });
    const response = await POST(request, { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(403);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects a signature older than the 5-minute replay window', async () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const request = makeRequest(VALID_PAYLOAD, {
      'x-pagespace-signature': sign(VALID_PAYLOAD, staleTimestamp),
      'x-pagespace-timestamp': staleTimestamp,
    });
    const response = await POST(request, { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(403);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects a signature computed over a different body than the one delivered', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const request = makeRequest(VALID_PAYLOAD, {
      'x-pagespace-signature': sign(JSON.stringify({ content: 'other' }), timestamp),
      'x-pagespace-timestamp': timestamp,
    });
    const response = await POST(request, { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(403);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns a generic 404 for an unknown token, without revealing whether it ever existed', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'unknown' }) });
    expect(response.status).toBe(404);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns the same generic 404 for a disabled webhook (does not leak that the token is valid but off)', async () => {
    mockFindFirst.mockResolvedValue({ ...WEBHOOK, isEnabled: false });
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(404);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('accepts a verified delivery to a non-CHANNEL page with 202 action:none and records no-action on the row', async () => {
    mockPageFindFirst.mockResolvedValue({ type: 'DOCUMENT' });
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, action: 'none' });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('still requires a valid signature before the non-CHANNEL 202 path — no unauthenticated probe', async () => {
    mockPageFindFirst.mockResolvedValue({ type: 'DOCUMENT' });
    const response = await POST(makeRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('maps a payload-validation error from the service to a 400 with the message', async () => {
    mockPublish.mockResolvedValue({ ok: false, error: 'content must not be empty' });
    const badPayload = JSON.stringify({ content: '   ' });
    const response = await POST(signedRequest(badPayload), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'content must not be empty' });
  });

  it('passes a non-JSON body through as null so the service rejects it as invalid — never a crash', async () => {
    mockPublish.mockResolvedValue({ ok: false, error: 'payload must be a JSON object' });
    const response = await POST(signedRequest('not json'), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(400);
    expect(mockPublish).toHaveBeenCalledWith('wh-1', null);
  });

  it('maps rate_limited to 429', async () => {
    mockPublish.mockResolvedValue({ ok: false, error: 'rate_limited' });
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(429);
  });

  it('maps channel_not_found to the generic 404', async () => {
    mockPublish.mockResolvedValue({ ok: false, error: 'channel_not_found' });
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(404);
  });

  it('maps internal_error to 500', async () => {
    mockPublish.mockResolvedValue({ ok: false, error: 'internal_error' });
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(500);
  });
});
