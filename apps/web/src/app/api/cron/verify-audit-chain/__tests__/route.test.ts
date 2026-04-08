import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ============================================================================
// Contract Tests for /api/cron/verify-audit-chain — Webhook Alerting (#544)
// ============================================================================

const mockVerifyChain = vi.hoisted(() => vi.fn());

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

vi.mock('@pagespace/lib', () => ({
  verifySecurityAuditChain: mockVerifyChain,
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn().mockReturnValue(null),
}));

// Spy on global fetch for webhook assertions
const fetchSpy = vi.spyOn(globalThis, 'fetch');

import { GET } from '../route';

// ============================================================================
// Fixtures
// ============================================================================

const CHAIN_FAILURE_RESULT = {
  isValid: false,
  totalEntries: 100,
  entriesVerified: 50,
  validEntries: 49,
  invalidEntries: 1,
  breakPoint: {
    entryId: 'entry_42',
    timestamp: new Date('2026-04-08T12:00:00Z'),
    position: 50,
    storedHash: 'abc123',
    computedHash: 'def456',
    previousHashUsed: 'prev789',
    description: 'Hash mismatch at position 50',
  },
  firstEntryId: 'entry_1',
  lastEntryId: 'entry_100',
  verificationStartedAt: new Date('2026-04-08T12:00:00Z'),
  verificationCompletedAt: new Date('2026-04-08T12:00:01Z'),
  durationMs: 1000,
};

const CHAIN_SUCCESS_RESULT = {
  ...CHAIN_FAILURE_RESULT,
  isValid: true,
  validEntries: 100,
  invalidEntries: 0,
  breakPoint: null,
};

const WEBHOOK_URL = 'https://alerts.example.com/webhook';

function makeRequest(): Request {
  return new Request('https://example.com/api/cron/verify-audit-chain', {
    method: 'GET',
  });
}

// ============================================================================
// Webhook Alerting on Chain Failure
// ============================================================================

describe('GET /api/cron/verify-audit-chain — webhook alerting', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('given chain failure with AUDIT_ALERT_WEBHOOK_URL set, should POST JSON payload to webhook URL', async () => {
    process.env.AUDIT_ALERT_WEBHOOK_URL = WEBHOOK_URL;
    mockVerifyChain.mockResolvedValue(CHAIN_FAILURE_RESULT);

    await GET(makeRequest());

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(options?.method).toBe('POST');

    const body = JSON.parse(options?.body as string);
    expect(body.event).toBe('audit_chain_integrity_failure');
    expect(body.timestamp).toBeDefined();
    expect(body.environment).toBe(process.env.NODE_ENV);
    expect(body.details).toMatchObject({
      isValid: false,
      breakPoint: expect.objectContaining({ entryId: 'entry_42' }),
    });
  });

  it('given chain failure without AUDIT_ALERT_WEBHOOK_URL, should only log to console (no fetch call)', async () => {
    delete process.env.AUDIT_ALERT_WEBHOOK_URL;
    mockVerifyChain.mockResolvedValue(CHAIN_FAILURE_RESULT);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await GET(makeRequest());

    expect(consoleSpy).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('given webhook POST failure, should not throw (fire-and-forget)', async () => {
    process.env.AUDIT_ALERT_WEBHOOK_URL = WEBHOOK_URL;
    mockVerifyChain.mockResolvedValue(CHAIN_FAILURE_RESULT);
    fetchSpy.mockRejectedValue(new Error('Network timeout'));

    const response = await GET(makeRequest());

    // Route should still return a successful response despite webhook failure
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.isValid).toBe(false);
  });

  it('given chain verification succeeds, should NOT call webhook even if URL is set', async () => {
    process.env.AUDIT_ALERT_WEBHOOK_URL = WEBHOOK_URL;
    mockVerifyChain.mockResolvedValue(CHAIN_SUCCESS_RESULT);

    await GET(makeRequest());

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
