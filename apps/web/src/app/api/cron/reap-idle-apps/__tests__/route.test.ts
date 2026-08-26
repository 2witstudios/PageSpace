/**
 * Contract tests for /api/cron/reap-idle-apps.
 *
 * What matters here is not the counters but WHICH OUTCOMES REDDEN A CRON. This
 * feature ships dark, and a dark feature that returns 500 on every tick trains an
 * operator to ignore the one tick that mattered. The other half is the reverse: a
 * machine we asked Fly to stop and could not must be loud, because its awake window
 * is deliberately left open and it is still costing its payer money.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReap, mockAudit } = vi.hoisted(() => ({
  mockReap: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/services/app-hosting/idle-reaper', () => ({
  defaultIdleReaperDeps: {},
  reapIdlePublishedAppsSerialized: mockReap,
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
}));

const { mockCapture, mockMessage, mockFlush } = vi.hoisted(() => ({
  mockCapture: vi.fn(),
  mockMessage: vi.fn(),
  mockFlush: vi.fn(async () => true),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: mockCapture,
  captureMessage: mockMessage,
  flush: mockFlush,
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
  return new Request('http://localhost:3000/api/cron/reap-idle-apps');
}

/** A run the reaper could actually produce: three candidates, two stopped. */
function reapedRun(over: Record<string, unknown> = {}) {
  return {
    outcome: 'reaped',
    processed: 3,
    stopped: 2,
    settledSeconds: 1234.5,
    active: 1,
    noActivitySignal: 0,
    lockBusy: 0,
    refused: 0,
    stopFailed: 0,
    failed: 0,
    idleSeconds: 900,
    sourceFailed: false,
    ...over,
  };
}

describe('/api/cron/reap-idle-apps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockReap.mockResolvedValue(reapedRun());
  });

  it('refuses an unsigned request without reaping anything', async () => {
    vi.mocked(validateSignedCronRequest).mockReturnValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) as never,
    );

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(mockReap).not.toHaveBeenCalled();
  });

  it('surfaces the counters and audits the tick', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, stopped: 2, settledSeconds: 1234.5, idleSeconds: 900 });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'cron_job', resourceId: 'reap_idle_apps' }),
    );
  });

  it.each(['disabled', 'reaping_disabled'] as const)(
    'given %s, should answer a GREEN 200 — a dark or switched-off feature must never redden a live cron',
    async (outcome) => {
      mockReap.mockResolvedValue({ outcome });

      const response = await GET(makeRequest());

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, outcome });
      expect(mockCapture).not.toHaveBeenCalled();
    },
  );

  it('given the advisory lock is held, should answer a green 200 and alert nobody', async () => {
    mockReap.mockResolvedValue({ outcome: 'lock_busy' });

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, outcome: 'lock_busy' });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('given a stop Fly REFUSED, should alert — that machine is probably still running and billing', async () => {
    mockReap.mockResolvedValue(reapedRun({ stopped: 0, stopFailed: 2 }));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockCapture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ fingerprint: ['idle-reaper-stop-failed'] }),
    );
  });

  it('given the row source was unreadable, should alert under its OWN fingerprint', async () => {
    // Fingerprinted on the cause rather than the message, which carries changing
    // counts and would open a fresh Sentry issue every tick.
    mockReap.mockResolvedValue(reapedRun({ processed: 0, stopped: 0, active: 0, sourceFailed: true }));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockCapture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ fingerprint: ['idle-reaper-source-unreadable'] }),
    );
  });

  it('does NOT alert on lockBusy, refused or active rows — every one of them self-corrects next tick', async () => {
    mockReap.mockResolvedValue(reapedRun({ stopped: 0, lockBusy: 2, refused: 1, active: 3 }));

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('given the reaper itself throws, should answer 500 rather than propagate', async () => {
    mockReap.mockRejectedValue(new Error('pool exhausted'));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, error: 'pool exhausted' });
  });
});
