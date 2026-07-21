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

// The seen-id store, mocked at the lib-module boundary like every other
// db-touching lib module here (the lib dist requires @pagespace/db natively,
// outside vitest's mock interception). The Map faithfully emulates the store's
// contract — claim marks pending, complete marks completed (→ duplicate),
// release deletes — while `deriveWebhookDeliveryId` stays REAL, so the
// signed-material-only identity rule the replay tests pin is the production
// one. The SQL-level claim/complete/release logic has its own unit coverage
// in packages/lib/src/security/__tests__/webhook-delivery-idempotency.test.ts.
const seenStore = new Map<string, 'pending' | 'completed'>();
const mockClaim = vi.fn(async (webhookId: string, deliveryId: string) => {
  const key = `${webhookId}:${deliveryId}`;
  const state = seenStore.get(key);
  if (state === 'completed') return 'duplicate' as const;
  if (state === 'pending') return 'pending' as const;
  seenStore.set(key, 'pending');
  return 'claimed' as const;
});
const mockComplete = vi.fn(async (webhookId: string, deliveryId: string) => {
  // Like the real module's UPDATE, completing a key that holds no pending
  // claim is a no-op — it must never conjure a completed marker from nothing.
  if (seenStore.get(`${webhookId}:${deliveryId}`) === 'pending') {
    seenStore.set(`${webhookId}:${deliveryId}`, 'completed');
  }
});
const mockRelease = vi.fn(async (webhookId: string, deliveryId: string) => {
  seenStore.delete(`${webhookId}:${deliveryId}`);
});
vi.mock('@pagespace/lib/security/webhook-delivery-idempotency', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@pagespace/lib/security/webhook-delivery-idempotency')>();
  return {
    deriveWebhookDeliveryId: actual.deriveWebhookDeliveryId,
    claimWebhookDelivery: (...args: [string, string]) => mockClaim(...args),
    completeWebhookDelivery: (...args: [string, string]) => mockComplete(...args),
    releaseWebhookDelivery: (...args: [string, string]) => mockRelease(...args),
  };
});
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

// `after()` schedules post-response work. In the test it runs the callback
// immediately so the fan-out scheduling is observable synchronously.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (fn: () => unknown) => { void fn(); } };
});

const mockFindTriggers = vi.fn();
vi.mock('@/lib/webhooks/page-webhook-trigger-queries', () => ({
  findEnabledPageWebhookTriggers: (...args: unknown[]) => mockFindTriggers(...args),
}));

const mockFireTriggers = vi.fn();
vi.mock('@/lib/webhooks/fire-page-webhook-triggers', () => ({
  firePageWebhookTriggers: (...args: unknown[]) => mockFireTriggers(...args),
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
  seenStore.clear();
  mockFindFirst.mockResolvedValue(WEBHOOK);
  mockDispatch.mockResolvedValue({ kind: 'handled' });
  // Default: no workflow triggers bound. Composability tests override this.
  mockFindTriggers.mockResolvedValue({ success: true, data: [] });
  mockFireTriggers.mockResolvedValue(undefined);
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
      hasEnabledTriggers: false,
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
    expect(mockFireTriggers).not.toHaveBeenCalled();
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
    expect(mockDispatch).toHaveBeenCalledWith({ webhookId: 'wh-1', pageId: 'page-1', payload: null, hasEnabledTriggers: false });
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

  // ── Trigger fan-out composability ───────────────────────────────────────

  it('does not fan out to triggers when none are bound (default handled path)', async () => {
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(200);
    expect(mockFireTriggers).not.toHaveBeenCalled();
  });

  it('COMPOSES: one handled CHANNEL delivery both runs the default action AND fires the bound workflow', async () => {
    const triggers = [{ id: 't1', workflowId: 'wf1', pageWebhookId: 'wh-1' }];
    mockFindTriggers.mockResolvedValue({ success: true, data: triggers });

    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });

    // Default action still runs, sender still gets 200 — and the dispatcher is
    // told triggers are firing (so it never records 'no action configured').
    expect(response.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ hasEnabledTriggers: true }));
    // Workflow fan-out fired alongside, with the resolved triggers + parsed envelope.
    expect(mockFireTriggers).toHaveBeenCalledTimes(1);
    expect(mockFireTriggers).toHaveBeenCalledWith(triggers, { content: 'deploy finished' });
  });

  it('fires bound workflows for a no-handler page and returns 202 action:triggers (no no-action write)', async () => {
    mockDispatch.mockResolvedValue({ kind: 'no_action' });
    const triggers = [{ id: 't1', workflowId: 'wf1', pageWebhookId: 'wh-1' }];
    mockFindTriggers.mockResolvedValue({ success: true, data: triggers });

    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, action: 'triggers' });
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ hasEnabledTriggers: true }));
    expect(mockFireTriggers).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire triggers when the delivery never reached a valid page (trashed/missing → not_found)', async () => {
    mockDispatch.mockResolvedValue({ kind: 'failed', error: 'not_found' });
    const triggers = [{ id: 't1', workflowId: 'wf1', pageWebhookId: 'wh-1' }];
    mockFindTriggers.mockResolvedValue({ success: true, data: triggers });

    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });

    expect(response.status).toBe(404);
    expect(mockFireTriggers).not.toHaveBeenCalled();
  });

  it('does NOT fire triggers when the default handler fails (429) — a retryable non-2xx must not perform AI side effects', async () => {
    mockDispatch.mockResolvedValue({ kind: 'failed', error: 'rate_limited' });
    const triggers = [{ id: 't1', workflowId: 'wf1', pageWebhookId: 'wh-1' }];
    mockFindTriggers.mockResolvedValue({ success: true, data: triggers });

    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });

    expect(response.status).toBe(429);
    expect(mockFireTriggers).not.toHaveBeenCalled();
  });

  it('does NOT fire triggers for a rejected/malformed envelope (400) — no AI side effects on a rejected, retryable delivery', async () => {
    mockDispatch.mockResolvedValue({ kind: 'failed', error: 'payload must be a JSON object' });
    const triggers = [{ id: 't1', workflowId: 'wf1', pageWebhookId: 'wh-1' }];
    mockFindTriggers.mockResolvedValue({ success: true, data: triggers });

    const response = await POST(signedRequest('not json'), { params: Promise.resolve({ token: 'tok-abc' }) });

    expect(response.status).toBe(400);
    expect(mockFireTriggers).not.toHaveBeenCalled();
  });

  // ── Replay idempotency (F4) ─────────────────────────────────────────────
  //
  // The signature scheme's ±5-minute window alone lets a captured, correctly
  // signed request replay unlimited times in-window — each replay re-posting
  // the channel message AND re-firing every bound workflow. These tests pin
  // the seen-id defense: one signed delivery is processed exactly once; a
  // replay short-circuits as a no-op success AFTER signature verification and
  // BEFORE any dispatch or trigger fan-out.

  describe('replay idempotency', () => {
    const params = () => ({ params: Promise.resolve({ token: 'tok-abc' }) });

    function identicalSignedHeaders(body: string, extra: Record<string, string> = {}) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      return { 'x-pagespace-signature': sign(body, timestamp), 'x-pagespace-timestamp': timestamp, ...extra };
    }

    it('delivers the exact same signed request only ONCE — the replay is a duplicate no-op (no second channel post, no second workflow fire)', async () => {
      const triggers = [{ id: 't1', workflowId: 'wf1', pageWebhookId: 'wh-1' }];
      mockFindTriggers.mockResolvedValue({ success: true, data: triggers });
      const headers = identicalSignedHeaders(VALID_PAYLOAD);

      const first = await POST(makeRequest(VALID_PAYLOAD, headers), params());
      expect(first.status).toBe(200);
      expect(mockDispatch).toHaveBeenCalledTimes(1);
      expect(mockFireTriggers).toHaveBeenCalledTimes(1);

      const replay = await POST(makeRequest(VALID_PAYLOAD, headers), params());
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, duplicate: true });
      expect(mockDispatch).toHaveBeenCalledTimes(1);
      expect(mockFireTriggers).toHaveBeenCalledTimes(1);
    });

    it('never dedupes distinct signed deliveries (back-compat: existing senders keep working unchanged)', async () => {
      const bodyA = JSON.stringify({ content: 'deploy one' });
      const bodyB = JSON.stringify({ content: 'deploy two' });

      const first = await POST(makeRequest(bodyA, identicalSignedHeaders(bodyA)), params());
      const second = await POST(makeRequest(bodyB, identicalSignedHeaders(bodyB)), params());

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ ok: true });
      expect(mockDispatch).toHaveBeenCalledTimes(2);
    });

    it('cannot be bypassed by varying an unauthenticated delivery-id header on a replay — identity comes from the SIGNED material only', async () => {
      // The v0 HMAC covers only timestamp+body, so any delivery-id header is
      // attacker-writable on a captured request. If it participated in the
      // identity, each replay could mint a fresh claim key and deliver again.
      const headers = identicalSignedHeaders(VALID_PAYLOAD);

      const first = await POST(
        makeRequest(VALID_PAYLOAD, { ...headers, 'x-pagespace-delivery-id': 'attacker-1' }),
        params(),
      );
      const replay = await POST(
        makeRequest(VALID_PAYLOAD, { ...headers, 'x-pagespace-delivery-id': 'attacker-2' }),
        params(),
      );

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, duplicate: true });
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });

    it('treats a RE-SIGNED retry (fresh timestamp, same body) as a new delivery — at-least-once semantics unchanged', async () => {
      const now = Math.floor(Date.now() / 1000);
      const tsA = String(now - 30);
      const tsB = String(now);

      const first = await POST(
        makeRequest(VALID_PAYLOAD, {
          'x-pagespace-signature': sign(VALID_PAYLOAD, tsA),
          'x-pagespace-timestamp': tsA,
        }),
        params(),
      );
      const resigned = await POST(
        makeRequest(VALID_PAYLOAD, {
          'x-pagespace-signature': sign(VALID_PAYLOAD, tsB),
          'x-pagespace-timestamp': tsB,
        }),
        params(),
      );

      expect(first.status).toBe(200);
      expect(resigned.status).toBe(200);
      expect(await resigned.json()).toEqual({ ok: true });
      expect(mockDispatch).toHaveBeenCalledTimes(2);
    });

    it('answers a retryable 409 (never a success) for an identical delivery still IN FLIGHT — a concurrent retry must not be acknowledged before the work is committed', async () => {
      const headers = identicalSignedHeaders(VALID_PAYLOAD);
      let finishDispatch!: (result: { kind: string }) => void;
      mockDispatch.mockImplementationOnce(
        () => new Promise((resolve) => { finishDispatch = resolve; }),
      );

      // First attempt reaches dispatch and hangs there, holding a pending claim.
      const firstPromise = POST(makeRequest(VALID_PAYLOAD, headers), params());
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Identical concurrent retry: the work is NOT committed yet, so a 200
      // here could lose the delivery if the first attempt later fails.
      const concurrent = await POST(makeRequest(VALID_PAYLOAD, headers), params());
      expect(concurrent.status).toBe(409);
      expect(concurrent.headers.get('Retry-After')).toBe('5');
      expect(mockDispatch).toHaveBeenCalledTimes(1);

      // First attempt completes; from now on identical requests are duplicates.
      finishDispatch({ kind: 'handled' });
      const first = await firstPromise;
      expect(first.status).toBe(200);

      const afterCompletion = await POST(makeRequest(VALID_PAYLOAD, headers), params());
      expect(afterCompletion.status).toBe(200);
      expect(await afterCompletion.json()).toEqual({ ok: true, duplicate: true });
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });

    it('releases the claim when the delivery FAILS, so a sender retry still delivers (at-least-once preserved)', async () => {
      const headers = identicalSignedHeaders(VALID_PAYLOAD);
      mockDispatch.mockResolvedValueOnce({ kind: 'failed', error: 'rate_limited' });

      const failed = await POST(makeRequest(VALID_PAYLOAD, headers), params());
      expect(failed.status).toBe(429);

      const retry = await POST(makeRequest(VALID_PAYLOAD, headers), params());
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ ok: true });
      expect(mockDispatch).toHaveBeenCalledTimes(2);
    });

    it('releases the claim on a trigger-lookup 503 so the retry delivers both actions', async () => {
      const headers = identicalSignedHeaders(VALID_PAYLOAD);
      mockFindTriggers.mockResolvedValueOnce({ success: false, error: 'db down' });

      const failed = await POST(makeRequest(VALID_PAYLOAD, headers), params());
      expect(failed.status).toBe(503);
      expect(mockDispatch).not.toHaveBeenCalled();

      const retry = await POST(makeRequest(VALID_PAYLOAD, headers), params());
      expect(retry.status).toBe(200);
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });

    it('does NOT un-commit a completed delivery when a failure happens AFTER acceptance — the retry is acknowledged as duplicate, never double-delivered', async () => {
      // Defensive invariant: nothing in the CURRENT route throws between
      // completion and the response in production (the real after() defers
      // its callback past the response; only this file's inline after() mock
      // lets the fan-out throw reach the catch). The test pins the catch-all
      // contract for any future code on that path: once the work committed,
      // a late failure answers 500 WITHOUT releasing, so the retry gets
      // {duplicate:true} instead of re-posting.
      const triggers = [{ id: 't1', workflowId: 'wf1', pageWebhookId: 'wh-1' }];
      mockFindTriggers.mockResolvedValue({ success: true, data: triggers });
      mockFireTriggers.mockImplementationOnce(() => {
        throw new Error('fan-out scheduling blew up');
      });
      const headers = identicalSignedHeaders(VALID_PAYLOAD);

      const failedAfterCommit = await POST(makeRequest(VALID_PAYLOAD, headers), params());
      expect(failedAfterCommit.status).toBe(500);
      expect(mockDispatch).toHaveBeenCalledTimes(1);

      const retry = await POST(makeRequest(VALID_PAYLOAD, headers), params());
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ ok: true, duplicate: true });
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });

    it('proceeds normally when the claim store fails OPEN (verdict "claimed" on both of two identical requests) — a store outage must never swallow deliveries', async () => {
      // The real module answers 'claimed' when the store is unreachable; at
      // the route level that must mean both requests deliver (the composed
      // system still bounds them: dispatch shares the same DB and its rate
      // limit fails closed in production).
      mockClaim.mockResolvedValueOnce('claimed').mockResolvedValueOnce('claimed');
      const headers = identicalSignedHeaders(VALID_PAYLOAD);

      const first = await POST(makeRequest(VALID_PAYLOAD, headers), params());
      const second = await POST(makeRequest(VALID_PAYLOAD, headers), params());

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(mockDispatch).toHaveBeenCalledTimes(2);
    });

    it('does NOT touch the claim store for a request that fails signature verification — an attacker cannot claim anything without the secret', async () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const forged = await POST(
        makeRequest(VALID_PAYLOAD, {
          'x-pagespace-signature': sign(VALID_PAYLOAD, timestamp, 'wrong-secret'),
          'x-pagespace-timestamp': timestamp,
        }),
        params(),
      );
      expect(forged.status).toBe(403);
      expect(mockClaim).not.toHaveBeenCalled();

      const genuine = await POST(
        makeRequest(VALID_PAYLOAD, {
          'x-pagespace-signature': sign(VALID_PAYLOAD, timestamp),
          'x-pagespace-timestamp': timestamp,
        }),
        params(),
      );
      expect(genuine.status).toBe(200);
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });
  });

  it('returns a retryable 503 (no dispatch, no fan-out) when the trigger lookup fails — never silently drops bound workflows', async () => {
    mockFindTriggers.mockResolvedValue({ success: false, error: 'db down' });

    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });

    // A transient lookup failure must reject the whole delivery as retryable —
    // not post to the channel, not fire workflows, not answer 2xx (which would
    // stop the sender retrying and permanently drop the bound workflows).
    expect(response.status).toBe(503);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockFireTriggers).not.toHaveBeenCalled();
  });
});
