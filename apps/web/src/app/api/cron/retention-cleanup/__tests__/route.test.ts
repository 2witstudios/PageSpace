/**
 * Contract tests for /api/cron/retention-cleanup
 * Verifies security audit logging on successful retention cleanup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRunRetentionCleanup, mockAudit } = vi.hoisted(() => ({
  mockRunRetentionCleanup: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/compliance/retention/retention-engine', () => ({
  runRetentionCleanup: mockRunRetentionCleanup,
}));

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/server', () => ({
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
  return new Request('http://localhost:3000/api/cron/retention-cleanup');
}

const MOCK_RESULTS = [
  { table: 'sessions', deleted: 10 },
  { table: 'verification_tokens', deleted: 5 },
];

describe('/api/cron/retention-cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockRunRetentionCleanup.mockResolvedValue(MOCK_RESULTS);
  });

  it('logs audit event on successful retention cleanup', async () => {
    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'retention_cleanup', details: { totalDeleted: 15, tables: MOCK_RESULTS } })
    );
  });

  it('does not log audit event when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('does not log audit event when cleanup throws', async () => {
    mockRunRetentionCleanup.mockRejectedValue(new Error('DB error'));

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });
});
