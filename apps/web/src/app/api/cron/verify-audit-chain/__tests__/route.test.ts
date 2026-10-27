/**
 * Contract tests for /api/cron/verify-audit-chain
 *
 * Verifies: structured logging, no breakPoint in response (info disclosure),
 * generic error messages, and full-audit-verification integration (#890
 * Phase 2, leaf 5: chain + anchors + co-stream where configured).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRunFullAuditVerification, mockLoggers } = vi.hoisted(() => ({
  mockRunFullAuditVerification: vi.fn(),
  mockLoggers: {
    security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/full-audit-verification', () => ({
  runFullAuditVerification: mockRunFullAuditVerification,
}));

const mockAudit = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: mockLoggers,

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
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

const SKIPPED_ANCHORS = {
  configured: false as const,
  skippedReason: 'anchoring is not enabled (AUDIT_ANCHOR_ENABLED)',
};
const SKIPPED_CO_STREAM = {
  configured: false as const,
  skippedReason: 'no collector co-stream records supplied',
};

function fullResult(chain: typeof VALID_CHAIN_RESULT | typeof BROKEN_CHAIN_RESULT, overrides: Record<string, unknown> = {}) {
  return {
    chain,
    anchors: SKIPPED_ANCHORS,
    coStream: SKIPPED_CO_STREAM,
    isValid: chain.isValid,
    ...overrides,
  };
}

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/verify-audit-chain');
}

describe('/api/cron/verify-audit-chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockRunFullAuditVerification.mockResolvedValue(fullResult(VALID_CHAIN_RESULT));
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
    mockRunFullAuditVerification.mockResolvedValue(fullResult(BROKEN_CHAIN_RESULT));

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.isValid).toBe(false);
    expect(body.invalidEntries).toBe(1);
    expect(body).not.toHaveProperty('breakPoint');
  });

  it('logs breakPoint details server-side on chain failure', async () => {
    mockRunFullAuditVerification.mockResolvedValue(fullResult(BROKEN_CHAIN_RESULT));

    await GET(makeRequest());

    expect(mockLoggers.security.error).toHaveBeenCalledWith(
      expect.stringContaining('SECURITY ALERT'),
      expect.objectContaining({
        breakPoint: BROKEN_CHAIN_RESULT.breakPoint,
      })
    );
  });

  it('returns generic error message on exception', async () => {
    mockRunFullAuditVerification.mockRejectedValue(new Error('DB connection lost'));

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Internal server error');
    expect(body.error).not.toContain('DB connection');
  });

  it('logs actual error server-side on exception', async () => {
    const error = new Error('DB connection lost');
    mockRunFullAuditVerification.mockRejectedValue(error);

    await GET(makeRequest());

    expect(mockLoggers.api.error).toHaveBeenCalledWith(
      expect.stringContaining('verify audit chain'),
      expect.objectContaining({ error })
    );
  });

  it('calls runFullAuditVerification with periodic source and stopOnFirstBreak', async () => {
    await GET(makeRequest());

    expect(mockRunFullAuditVerification).toHaveBeenCalledWith({
      source: 'periodic',
      chain: { stopOnFirstBreak: true },
    });
  });

  it('reports skipped anchor/co-stream checks with their reasons (explicit degradation)', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.anchors).toEqual(SKIPPED_ANCHORS);
    expect(body.coStream).toEqual(SKIPPED_CO_STREAM);
    expect(body.chainValid).toBe(true);
  });

  it('given a configured anchor check that fails, reports composite isValid=false while chainValid stays true', async () => {
    mockRunFullAuditVerification.mockResolvedValue(
      fullResult(VALID_CHAIN_RESULT, {
        anchors: {
          configured: true,
          report: {
            allMatch: false,
            results: [],
            counts: { match: 1, hash_mismatch: 1, seq_gap: 0, unverifiable: 0 },
          },
        },
        isValid: false,
      })
    );

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.isValid).toBe(false);
    expect(body.chainValid).toBe(true);
    expect(body.anchors).toEqual({
      configured: true,
      allMatch: false,
      counts: { match: 1, hash_mismatch: 1, seq_gap: 0, unverifiable: 0 },
    });
    // Anchor details beyond counts (hashes, seqs) never leak into the response.
    expect(body.anchors).not.toHaveProperty('results');
  });

  it('logs audit event on successful chain verification', async () => {
    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.read', resourceType: 'cron_job', resourceId: 'verify_audit_chain', details: { isValid: true, entriesVerified: 100 } })
    );
    expect(mockAudit.mock.calls[0]?.[0]).not.toHaveProperty('userId');
  });

  it('logs audit event on failed chain verification', async () => {
    mockRunFullAuditVerification.mockResolvedValue(fullResult(BROKEN_CHAIN_RESULT));

    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.read', resourceType: 'cron_job', resourceId: 'verify_audit_chain', details: { isValid: false, entriesVerified: 100 } })
    );
    expect(mockAudit.mock.calls[0]?.[0]).not.toHaveProperty('userId');
  });

  it('does not log audit event when verification throws', async () => {
    mockRunFullAuditVerification.mockRejectedValue(new Error('DB connection lost'));

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('POST delegates to GET', async () => {
    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.isValid).toBe(true);
  });
});
