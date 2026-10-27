/**
 * Contract tests for /api/cron/archive-activity-logs
 * Verifies HMAC gating, audit logging, and before/after chain integrity reporting
 * for the activity_logs hot→cold archival (isArchived flip) cron.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockArchive, mockConfig, mockQuickCheck, mockAudit } = vi.hoisted(() => ({
  mockArchive: vi.fn(),
  mockConfig: vi.fn(),
  mockQuickCheck: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/compliance/retention/activity-log-archival', () => ({
  archiveActivityLogs: mockArchive,
  getActivityLogArchivalConfig: mockConfig,
}));

vi.mock('@pagespace/lib/monitoring/hash-chain-verifier', () => ({
  quickIntegrityCheck: mockQuickCheck,
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
}));

vi.mock('@pagespace/db/db', () => ({ db: {} }));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/archive-activity-logs');
}

describe('/api/cron/archive-activity-logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockConfig.mockReturnValue({ archiveDays: 365, batchSize: 1000, maxRunMs: 25000 });
    mockArchive.mockResolvedValue({ table: 'activity_logs', archived: 7, batches: 1 });
    mockQuickCheck.mockResolvedValue({
      isLikelyValid: true,
      hasChainSeed: true,
      lastEntriesValid: true,
      sampleValid: true,
      details: 'ok',
    });
  });

  it('returns the auth error and never archives when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(mockArchive).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('archives and emits a data.write audit event with the archived count', async () => {
    await GET(makeRequest());

    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.write',
        resourceType: 'cron_job',
        resourceId: 'archive_activity_logs',
        details: expect.objectContaining({ archived: 7 }),
      }),
    );
  });

  it('reports quickIntegrityCheck before and after the run', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(mockQuickCheck).toHaveBeenCalledTimes(2);
    expect(body.chainIntegrity.before.isLikelyValid).toBe(true);
    expect(body.chainIntegrity.after.isLikelyValid).toBe(true);
    expect(body.archived).toBe(7);
  });
});
