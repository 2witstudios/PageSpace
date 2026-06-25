/**
 * Contract tests for /api/cron/purge-ai-usage-logs
 * Verifies security audit logging on successful AI usage log purge.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPurge, mockAudit } = vi.hoisted(() => ({
  mockPurge: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/ai-usage-purge', () => ({
  purgeAiUsageLogs: mockPurge,
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

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/purge-ai-usage-logs');
}

describe('/api/cron/purge-ai-usage-logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockPurge.mockResolvedValue(3);
  });

  it('logs audit event on successful purge', async () => {
    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'purge_ai_usage', details: { purged: 3 } })
    );
  });

  it('does not log audit event when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('does not log audit event when purge throws', async () => {
    mockPurge.mockRejectedValue(new Error('DB error'));

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('purges using the env-configured retention window, not a hardcoded 90', async () => {
    const original = process.env.RETENTION_AI_USAGE_LOGS_DAYS;
    process.env.RETENTION_AI_USAGE_LOGS_DAYS = '30';
    try {
      const before = Date.now();
      await GET(makeRequest());
      const after = Date.now();

      expect(mockPurge).toHaveBeenCalledTimes(1);
      const cutoff = mockPurge.mock.calls[0][0] as Date;
      const expectedMs = 30 * 24 * 60 * 60 * 1000;
      // cutoff ≈ now - 30d; bounded by the test's wall-clock window
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - expectedMs - 5);
      expect(cutoff.getTime()).toBeLessThanOrEqual(after - expectedMs + 5);
    } finally {
      if (original === undefined) delete process.env.RETENTION_AI_USAGE_LOGS_DAYS;
      else process.env.RETENTION_AI_USAGE_LOGS_DAYS = original;
    }
  });
});
