/**
 * Contract tests for /api/cron/cleanup-tokens
 * Verifies security audit logging on successful token cleanup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockCleanup, mockSecurityAudit } = vi.hoisted(() => ({
  mockCleanup: vi.fn(),
  mockSecurityAudit: { logDataAccess: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  cleanupExpiredDeviceTokens: mockCleanup,
}));

vi.mock('@pagespace/lib/server', () => ({
  securityAudit: mockSecurityAudit,
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
  return new Request('http://localhost:3000/api/cron/cleanup-tokens');
}

describe('/api/cron/cleanup-tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockCleanup.mockResolvedValue(5);
  });

  it('logs audit event on successful token cleanup', async () => {
    await GET(makeRequest());

    expect(mockSecurityAudit.logDataAccess).toHaveBeenCalledWith(
      'system', 'delete', 'cron_job', 'cleanup_tokens', { cleaned: 5 }
    );
  });

  it('does not log audit event when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    await GET(makeRequest());

    expect(mockSecurityAudit.logDataAccess).not.toHaveBeenCalled();
  });

  it('does not log audit event when cleanup throws', async () => {
    mockCleanup.mockRejectedValue(new Error('DB error'));

    await GET(makeRequest());

    expect(mockSecurityAudit.logDataAccess).not.toHaveBeenCalled();
  });
});
