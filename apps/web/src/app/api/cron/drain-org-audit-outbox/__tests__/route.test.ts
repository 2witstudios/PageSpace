/**
 * Contract tests for /api/cron/drain-org-audit-outbox: HMAC gating, the drain runs, its counts reach the response,
 * and events still retrying make the run a 500. Delivery itself (staging, retry, never dropping) is proven against
 * Postgres in packages/lib/src/audit/__tests__/org-audit-outbox.integration.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDrain, mockLogError } = vi.hoisted(() => ({ mockDrain: vi.fn(), mockLogError: vi.fn() }));

vi.mock('@/lib/auth/cron-auth', () => ({ validateSignedCronRequest: vi.fn() }));
vi.mock('@pagespace/lib/audit/org-audit', () => ({ drainOrgAuditOutbox: mockDrain }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { system: { error: mockLogError } } }));
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { 'content-type': 'application/json' } }),
  },
}));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

const request = () => new Request('http://localhost:3000/api/cron/drain-org-audit-outbox');

describe('/api/cron/drain-org-audit-outbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  it('AUD-1 (partial) an unsigned request is refused and nothing is drained', async () => {
    vi.mocked(validateSignedCronRequest).mockReturnValue(new Response('no', { status: 401 }) as never);
    expect((await GET(request())).status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it('AUD-1 (partial) drains the outbox and reports what it delivered', async () => {
    mockDrain.mockResolvedValue({ delivered: 4, retrying: 0 });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, delivered: 4, retrying: 0 });
  });

  it('AUD-1 (partial) events the chain still refuses make the run a 500 so it pages', async () => {
    mockDrain.mockResolvedValue({ delivered: 1, retrying: 2 });
    expect((await GET(request())).status).toBe(500);
    expect(mockLogError).toHaveBeenCalled();
  });

  it('a drain that throws is a 500', async () => {
    mockDrain.mockRejectedValue(new Error('db down'));
    expect((await GET(request())).status).toBe(500);
  });
});
