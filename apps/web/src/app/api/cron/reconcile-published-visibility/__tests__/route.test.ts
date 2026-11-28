/**
 * Contract tests for /api/cron/reconcile-published-visibility: HMAC gating, publishing-not-configured skip, the
 * sweep runs against the real object store adapter, counts reach the response and audit event, and a prefix that
 * failed to move makes the run a 500. The move rules (park, restore, idempotence, retry, newer-object) are proven in
 * packages/lib/src/organizations/__tests__/published-visibility*.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSweep, mockAudit, mockLogError, mockConfigured } = vi.hoisted(() => ({
  mockSweep: vi.fn(),
  mockAudit: vi.fn(),
  mockLogError: vi.fn(),
  mockConfigured: vi.fn(() => true),
}));

vi.mock('@/lib/auth/cron-auth', () => ({ validateSignedCronRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/published-visibility', () => ({ reconcileAllPublishedVisibility: mockSweep }));
vi.mock('@/lib/canvas/published-storage', () => ({ createPublishedObjectStore: () => ({ store: true }), isPublishConfigured: mockConfigured }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: mockAudit }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { system: { error: mockLogError } } }));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

const request = () => new Request('http://localhost:3000/api/cron/reconcile-published-visibility');

describe('/api/cron/reconcile-published-visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockConfigured.mockReturnValue(true);
  });

  it('POL-4 (partial) an unsigned request is refused and the sweep never runs', async () => {
    vi.mocked(validateSignedCronRequest).mockReturnValue(new Response('no', { status: 401 }) as never);
    expect((await GET(request())).status).toBe(401);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('POL-4 (partial) with no publish bucket configured it does nothing', async () => {
    mockConfigured.mockReturnValue(false);
    const res = await GET(request());
    expect(await res.json()).toEqual({ success: true, skipped: 'publishing_not_configured' });
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('POL-4 (partial) runs the sweep against the object store and returns and audits its counts', async () => {
    mockSweep.mockResolvedValue([
      { prefix: 'a', action: 'parked', objects: 3 },
      { prefix: 'b', action: 'restored', objects: 2 },
      { prefix: 'c', action: 'unchanged', objects: 0 },
    ]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, prefixes: 3, parked: 1, restored: 1, unchanged: 1, failed: 0 });
    expect(mockSweep).toHaveBeenCalledWith({ store: true });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'reconcile_published_visibility', details: { prefixes: 3, parked: 1, restored: 1, unchanged: 1, failed: 0 } }));
  });

  it('POL-4 (partial) a prefix that failed to move makes the run a 500 naming the count, so it pages and the next tick retries', async () => {
    mockSweep.mockResolvedValue([{ prefix: 'a', action: 'failed', objects: 0, error: 'store unavailable' }]);
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, failed: 1 });
    expect(mockLogError).toHaveBeenCalled();
  });

  it('POL-4 (partial) a sweep that throws is a 500, not a crash', async () => {
    mockSweep.mockRejectedValue(new Error('db down'));
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('db down');
  });
});
