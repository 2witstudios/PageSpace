/**
 * Contract + security tests for /api/cron/reconcile-message-unification.
 *
 * Same shape as the reconcile-orphaned-sprites suite: HMAC gating, audit
 * logging, result surfacing. The one addition specific to this route is the
 * assertion that a DIVERGENT run still returns 200 — the HTTP status reports
 * whether the CHECK ran, not what it found. Alerting keys off the error-level
 * log the reconciler emits, and a 500 here would make a live legacy writer
 * look like a broken cron and get muted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReconcile, mockAudit } = vi.hoisted(() => ({
  mockReconcile: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@/lib/repositories/message-unification-reconcile', () => ({
  reconcileMessageUnification: mockReconcile,
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    system: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  },
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

const cleanRun = {
  checked: 12,
  diverged: 0,
  unmirroredRows: 0,
  samples: [],
  windowHours: 24,
  capped: false,
};

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/reconcile-message-unification');
}

describe('/api/cron/reconcile-message-unification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockReconcile.mockResolvedValue(cleanRun);
  });

  it('given valid HMAC, should run the comparison and surface its counts', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, checked: 12, diverged: 0, unmirroredRows: 0 });
    expect(body.timestamp).toBeDefined();
  });

  it('given invalid HMAC, should return the auth error and never read a message table', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('given a thawed legacy leg, should still return 200 with the divergent samples', async () => {
    mockReconcile.mockResolvedValue({
      checked: 40,
      diverged: 2,
      unmirroredRows: 7,
      samples: [
        {
          conversationId: 'conv-a',
          unmirroredLegacy: 6,
          legacyCount: 10,
          unifiedCount: 4,
          legacyMaxCreatedAt: '2026-08-06 10:00:00.000000',
          unifiedMaxCreatedAt: '2026-08-06 09:00:00.000000',
        },
      ],
      windowHours: 24,
      capped: false,
    });

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, diverged: 2, unmirroredRows: 7 });
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].conversationId).toBe('conv-a');
  });

  it('should write an audit entry recording what was compared', async () => {
    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.read',
        resourceType: 'cron_job',
        resourceId: 'reconcile_message_unification',
        details: { checked: 12, diverged: 0, unmirroredRows: 0, windowHours: 24, capped: false },
      }),
    );
  });

  it('given a reconcile failure, should return 500 and not log audit', async () => {
    mockReconcile.mockRejectedValue(new Error('statement timeout'));

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ success: false, error: 'statement timeout' });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('POST should delegate to GET', async () => {
    const body = await (await POST(makeRequest())).json();

    expect(body).toMatchObject({ success: true, checked: 12 });
  });
});
