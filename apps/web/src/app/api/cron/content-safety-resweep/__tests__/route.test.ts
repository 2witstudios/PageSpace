/**
 * Contract tests for /api/cron/content-safety-resweep: HMAC gating, the window it asks for, one re-sweep per due
 * case, and a failed case turning the run into a 500. What a re-sweep does to storage is proven in
 * packages/lib/src/content-safety/__tests__/takedown.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDue, mockExecute, mockAudit, mockLogError } = vi.hoisted(() => ({
  mockDue: vi.fn(),
  mockExecute: vi.fn(),
  mockAudit: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({ validateSignedCronRequest: vi.fn() }));
vi.mock('@pagespace/lib/content-safety/case-store', () => ({ listCasesDueForResweep: mockDue }));
vi.mock('@/lib/content-safety/takedown-service', () => ({ executeTakedown: mockExecute }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: mockAudit }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { system: { error: mockLogError } } }));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

const request = () => new Request('http://localhost:3000/api/cron/content-safety-resweep');

describe('/api/cron/content-safety-resweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockDue.mockResolvedValue([]);
    mockExecute.mockResolvedValue({ action: 'resweep', status: 'actioned' });
  });

  it('refuses an unsigned request and sweeps nothing', async () => {
    vi.mocked(validateSignedCronRequest).mockReturnValue(new Response('no', { status: 401 }) as never);

    expect((await GET(request())).status).toBe(401);
    expect(mockDue).not.toHaveBeenCalled();
  });

  it('asks only for cases finished after the presigned-PUT window closed, within the last day', async () => {
    const before = Date.now();
    await GET(request());

    const { actionedBefore, actionedAfter } = mockDue.mock.calls[0][0] as { actionedBefore: Date; actionedAfter: Date };
    expect(before - actionedBefore.getTime()).toBeGreaterThanOrEqual(20 * 60 * 1000 - 5);
    expect(before - actionedAfter.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5);
  });

  it('re-sweeps each due case once, as the system, and reports the count', async () => {
    mockDue.mockResolvedValue([{ id: 'case-1' }, { id: 'case-2' }]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, due: 2, swept: 2 });
    expect(mockExecute.mock.calls).toEqual([
      [{ action: 'resweep', caseId: 'case-1' }, null],
      [{ action: 'resweep', caseId: 'case-2' }, null],
    ]);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'content_safety_resweep', details: { due: 2, swept: 2, failed: 0 } }));
  });

  it('keeps going past a case that fails and answers 500 so the run pages', async () => {
    mockDue.mockResolvedValue([{ id: 'case-1' }, { id: 'case-2' }, { id: 'case-3' }]);
    mockExecute
      .mockRejectedValueOnce(new Error('S3 down'))
      .mockResolvedValueOnce({ action: 'resweep', status: 'open', failedStep: 'delete_uploads' })
      .mockResolvedValueOnce({ action: 'resweep', status: 'actioned' });

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, due: 3, swept: 1, failedCaseIds: ['case-1', 'case-2'] });
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });
});
