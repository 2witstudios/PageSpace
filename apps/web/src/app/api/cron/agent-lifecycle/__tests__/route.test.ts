/**
 * Contract tests for /api/cron/agent-lifecycle: HMAC cron auth first, the
 * sweep wired to the GDPR erasure adapter, an audited summary, and a constant
 * 500 that never echoes an internal error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  validateSignedCronRequest: vi.fn(),
  sweepAgentLifecycle: vi.fn(),
  audit: vi.fn(),
  eraseUnclaimedAgent: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({ validateSignedCronRequest: mocks.validateSignedCronRequest }));
vi.mock('@pagespace/lib/services/agent-lifecycle', () => ({ sweepAgentLifecycle: mocks.sweepAgentLifecycle }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: mocks.audit }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { system: { error: vi.fn(), info: vi.fn() } } }));
vi.mock('@/lib/agent-auth/lifecycle-erasure', () => ({ eraseUnclaimedAgent: mocks.eraseUnclaimedAgent }));

import { GET, POST } from '../route';

const RESULT = { challengesPruned: 4, claimsPruned: 1, candidates: 3, erased: 2, kept: 1, failed: 0, batches: 1, stoppedBy: 'drained' as const, failures: [] };

function request(method = 'GET') {
  return new Request('http://web:3000/api/cron/agent-lifecycle', { method });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateSignedCronRequest.mockReturnValue(null);
  mocks.sweepAgentLifecycle.mockResolvedValue(RESULT);
});

describe('/api/cron/agent-lifecycle', () => {
  it('refuses an unsigned request before sweeping anything', async () => {
    mocks.validateSignedCronRequest.mockReturnValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.sweepAgentLifecycle).not.toHaveBeenCalled();
  });

  it('runs the sweep with the GDPR erasure adapter and reports and audits the counts', async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(mocks.sweepAgentLifecycle).toHaveBeenCalledWith({ now: expect.any(Date), eraseAgent: mocks.eraseUnclaimedAgent });
    expect(body).toMatchObject({ success: true, challengesPruned: 4, claimsPruned: 1, candidates: 3, erased: 2, kept: 1, failed: 0, batches: 1, stoppedBy: 'drained' });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'agent_lifecycle' }),
    );
  });

  it('reports partial failure (an erasure or a prune) without failing the request', async () => {
    mocks.sweepAgentLifecycle.mockResolvedValue({
      ...RESULT,
      challengesPruned: null,
      failed: 1,
      failures: [{ userId: 'a_1', error: 'x' }, { userId: null, error: 'prune challenges: y' }],
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: false, failed: 2, challengesPruned: null });
  });

  it('answers a constant 500 when the sweep itself throws', async () => {
    mocks.sweepAgentLifecycle.mockRejectedValue(new Error('connection string with secrets'));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('secrets');
  });

  it('accepts POST like every other cron endpoint', async () => {
    const response = await POST(request('POST'));
    expect(response.status).toBe(200);
  });
});
