/**
 * Contract tests for /api/cron/reconcile-orphaned-sprites
 * Verifies HMAC gating, audit logging, and that the reconcile result surfaces in
 * the response for the orphaned-Sprite teardown cron.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReconcile, mockAudit } = vi.hoisted(() => ({
  mockReconcile: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/services/machines/machine-orphan-reconcile', () => ({
  reconcileOrphanSprites: mockReconcile,
}));

vi.mock('@/lib/machines/machine-orphan-reconcile-runtime', () => ({
  defaultReconcileOrphanSpritesDeps: {},
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

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/reconcile-orphaned-sprites');
}

describe('/api/cron/reconcile-orphaned-sprites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockReconcile.mockResolvedValue({ processed: 0, torndown: 0, failed: 0 });
  });

  it('given valid HMAC, should run the reconcile and surface its counts', async () => {
    mockReconcile.mockResolvedValue({ processed: 3, torndown: 2, failed: 1 });

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, processed: 3, torndown: 2, failed: 1 });
    expect(body.timestamp).toBeDefined();
  });

  it('given invalid HMAC, should return the auth error and never touch a Sprite', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('should write an audit entry recording what was reclaimed', async () => {
    mockReconcile.mockResolvedValue({ processed: 2, torndown: 2, failed: 0 });

    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.write',
        resourceType: 'cron_job',
        resourceId: 'reconcile_orphaned_sprites',
        details: { processed: 2, torndown: 2, failed: 0 },
      }),
    );
  });

  it('given a reconcile failure, should return 500 and not log audit', async () => {
    mockReconcile.mockRejectedValue(new Error('host unreachable'));

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ success: false, error: 'host unreachable' });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('POST should delegate to GET', async () => {
    mockReconcile.mockResolvedValue({ processed: 1, torndown: 1, failed: 0 });

    const body = await (await POST(makeRequest())).json();

    expect(body).toMatchObject({ success: true, torndown: 1 });
  });
});
