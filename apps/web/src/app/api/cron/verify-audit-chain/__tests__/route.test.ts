/**
 * Contract tests for /api/cron/verify-audit-chain
 *
 * Verifies: structured logging, no breakPoint in response (info disclosure),
 * generic error messages, and verifyAndAlert integration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockVerifyAndAlert, mockLoggers } = vi.hoisted(() => ({
  mockVerifyAndAlert: vi.fn(),
  mockLoggers: {
    security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  verifyAndAlert: mockVerifyAndAlert,
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: mockLoggers,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

import { GET, POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

const VALID_CHAIN_RESULT = {
  isValid: true,
  totalEntries: 100,
  entriesVerified: 100,
  validEntries: 100,
  invalidEntries: 0,
  breakPoint: null,
  firstEntryId: 'entry_1',
  lastEntryId: 'entry_100',
  verificationStartedAt: new Date('2026-04-08T12:00:00Z'),
  verificationCompletedAt: new Date('2026-04-08T12:00:01Z'),
  durationMs: 1000,
};

const BROKEN_CHAIN_RESULT = {
  ...VALID_CHAIN_RESULT,
  isValid: false,
  validEntries: 49,
  invalidEntries: 1,
  breakPoint: {
    entryId: 'entry_50',
    timestamp: new Date('2026-04-08T12:00:00Z'),
    position: 50,
    storedHash: 'abc123',
    computedHash: 'def456',
    previousHashUsed: 'prev789',
    description: 'Hash mismatch at position 50',
  },
};

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/verify-audit-chain');
}

describe('/api/cron/verify-audit-chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockVerifyAndAlert.mockResolvedValue(VALID_CHAIN_RESULT);
  });

  it('returns auth error when cron request is invalid', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
  });

  it('returns valid chain result without breakPoint in response', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.isValid).toBe(true);
    expect(body.totalEntries).toBe(100);
    expect(body.validEntries).toBe(100);
    expect(body).not.toHaveProperty('breakPoint');
  });

  it('logs info on valid chain using structured logger', async () => {
    await GET(makeRequest());

    expect(mockLoggers.api.info).toHaveBeenCalledWith(
      expect.stringContaining('100 entries valid')
    );
  });

  it('returns invalid chain result without breakPoint in response', async () => {
    mockVerifyAndAlert.mockResolvedValue(BROKEN_CHAIN_RESULT);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.isValid).toBe(false);
    expect(body.invalidEntries).toBe(1);
    expect(body).not.toHaveProperty('breakPoint');
  });

  it('logs breakPoint details server-side on chain failure', async () => {
    mockVerifyAndAlert.mockResolvedValue(BROKEN_CHAIN_RESULT);

    await GET(makeRequest());

    expect(mockLoggers.security.error).toHaveBeenCalledWith(
      expect.stringContaining('SECURITY ALERT'),
      expect.objectContaining({
        breakPoint: BROKEN_CHAIN_RESULT.breakPoint,
      })
    );
  });

  it('returns generic error message on exception', async () => {
    mockVerifyAndAlert.mockRejectedValue(new Error('DB connection lost'));

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Internal server error');
    expect(body.error).not.toContain('DB connection');
  });

  it('logs actual error server-side on exception', async () => {
    const error = new Error('DB connection lost');
    mockVerifyAndAlert.mockRejectedValue(error);

    await GET(makeRequest());

    expect(mockLoggers.api.error).toHaveBeenCalledWith(
      expect.stringContaining('verify audit chain'),
      expect.objectContaining({ error })
    );
  });

  it('calls verifyAndAlert with periodic source', async () => {
    await GET(makeRequest());

    expect(mockVerifyAndAlert).toHaveBeenCalledWith('periodic', { stopOnFirstBreak: true });
  });

  it('POST delegates to GET', async () => {
    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.isValid).toBe(true);
  });
});
