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

const mockFindFirst = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pageWebhooks: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: (a: unknown, b: unknown) => ({ a, b }) }));
vi.mock('@pagespace/db/schema/page-webhooks', () => ({
  pageWebhooks: { id: 'pageWebhooks.id', webhookToken: 'pageWebhooks.webhookToken' },
}));

// Real decrypt-equivalent for the test: returns the plaintext secret directly,
// so the route's HMAC verification runs against a known value.
vi.mock('@pagespace/lib/encryption/field-crypto', () => ({
  decryptField: vi.fn(async (v: string) => (v === WEBHOOK.webhookSecretEncrypted ? SECRET : v)),
}));

const mockDispatch = vi.fn();
vi.mock('@pagespace/lib/services/page-webhook-dispatch', () => ({
  dispatchWebhookDelivery: (...args: unknown[]) => mockDispatch(...args),
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
  mockDispatch.mockResolvedValue({ kind: 'handled' });
});

describe('POST /api/webhooks/[token]', () => {
  it('accepts a validly signed request and dispatches the delivery for the resolved webhook', async () => {
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });

    expect(response.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith({
      webhookId: 'wh-1',
      pageId: 'page-1',
      payload: { content: 'deploy finished' },
    });
  });

  it('rejects a body over 64KB with 413 before any lookup or parse', async () => {
    const oversized = JSON.stringify({ content: 'x'.repeat(64 * 1024) });
    const response = await POST(signedRequest(oversized), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(413);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
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
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('rejects a request signed with the wrong secret', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const request = makeRequest(VALID_PAYLOAD, {
      'x-pagespace-signature': sign(VALID_PAYLOAD, timestamp, 'wrong-secret'),
      'x-pagespace-timestamp': timestamp,
    });
    const response = await POST(request, { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('rejects a signature older than the 5-minute replay window', async () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const request = makeRequest(VALID_PAYLOAD, {
      'x-pagespace-signature': sign(VALID_PAYLOAD, staleTimestamp),
      'x-pagespace-timestamp': staleTimestamp,
    });
    const response = await POST(request, { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('rejects a signature computed over a different body than the one delivered', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const request = makeRequest(VALID_PAYLOAD, {
      'x-pagespace-signature': sign(JSON.stringify({ content: 'other' }), timestamp),
      'x-pagespace-timestamp': timestamp,
    });
    const response = await POST(request, { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('returns a generic 404 for an unknown token, without revealing whether it ever existed', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'unknown' }) });
    expect(response.status).toBe(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('returns the same generic 404 for a disabled webhook (does not leak that the token is valid but off)', async () => {
    mockFindFirst.mockResolvedValue({ ...WEBHOOK, isEnabled: false });
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('maps a no_action dispatch (page type without a handler) to 202 accepted action:none', async () => {
    mockDispatch.mockResolvedValue({ kind: 'no_action' });
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, action: 'none' });
  });

  it('still requires a valid signature before the no-action 202 path — no unauthenticated probe', async () => {
    const response = await POST(makeRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('maps a payload-validation error from the dispatcher to a 400 with the message', async () => {
    mockDispatch.mockResolvedValue({ kind: 'failed', error: 'content must not be empty' });
    const badPayload = JSON.stringify({ content: '   ' });
    const response = await POST(signedRequest(badPayload), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'content must not be empty' });
  });

  it('passes a non-JSON body through as null so the dispatcher rejects it as a bad envelope — never a crash', async () => {
    mockDispatch.mockResolvedValue({ kind: 'failed', error: 'payload must be a JSON object' });
    const response = await POST(signedRequest('not json'), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(400);
    expect(mockDispatch).toHaveBeenCalledWith({ webhookId: 'wh-1', pageId: 'page-1', payload: null });
  });

  it('maps not_found to the generic 404', async () => {
    mockDispatch.mockResolvedValue({ kind: 'failed', error: 'not_found' });
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(404);
  });

  it('maps rate_limited to 429', async () => {
    mockDispatch.mockResolvedValue({ kind: 'failed', error: 'rate_limited' });
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(429);
  });

  it('maps channel_not_found to the generic 404', async () => {
    mockDispatch.mockResolvedValue({ kind: 'failed', error: 'channel_not_found' });
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(404);
  });

  it('maps internal_error to 500', async () => {
    mockDispatch.mockResolvedValue({ kind: 'failed', error: 'internal_error' });
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(500);
  });
});
