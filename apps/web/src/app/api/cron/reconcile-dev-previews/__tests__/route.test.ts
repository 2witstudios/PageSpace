/**
 * Contract tests for /api/cron/reconcile-dev-previews — the dev-preview
 * backstop sweep's endpoint: HMAC gating first, the run's counts in both the
 * response and the audit row, and a thrown sweep answered as a 500 rather
 * than a silent success.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReconcile, mockAudit } = vi.hoisted(() => ({ mockReconcile: vi.fn(), mockAudit: vi.fn() }));

vi.mock('@/lib/auth/cron-auth', () => ({ validateSignedCronRequest: vi.fn() }));
vi.mock('@/lib/dev-preview/preview-runtime', () => ({ reconcileStoppedDevPreviewsForCron: mockReconcile }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: mockAudit }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { system: { error: vi.fn() } } }));
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { 'content-type': 'application/json' } }),
  },
}));

import { GET, POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

const request = () => new Request('http://localhost:3000/api/cron/reconcile-dev-previews');

describe('/api/cron/reconcile-dev-previews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockReconcile.mockResolvedValue({ processed: 3, stopped: 1, skipped: 2, failed: 0 });
  });

  it('refuses an unsigned request BEFORE doing any work', async () => {
    vi.mocked(validateSignedCronRequest).mockReturnValue(new Response('no', { status: 401 }) as never);
    expect((await GET(request())).status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('runs the sweep and reports its counts, in the body and in the audit row', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, processed: 3, stopped: 1, skipped: 2, failed: 0 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'cron_job',
      resourceId: 'reconcile_dev_previews',
      details: { processed: 3, stopped: 1, skipped: 2, failed: 0 },
    }));
  });

  it('answers 500 when the sweep throws, rather than reporting a run that did not happen', async () => {
    mockReconcile.mockRejectedValueOnce(new Error('control plane down'));
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, error: 'control plane down' });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('POST is the same endpoint (the cron runner uses either)', async () => {
    expect((await POST(request())).status).toBe(200);
  });
});
