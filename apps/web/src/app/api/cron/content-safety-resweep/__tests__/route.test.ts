/**
 * Contract tests for /api/cron/content-safety-resweep: HMAC gating, the window it asks for, one re-sweep per due
 * case, and a failed case turning the run into a 500. What a re-sweep does to storage is proven in
 * packages/lib/src/content-safety/__tests__/takedown.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDue, mockUnfinished, mockExecute, mockSweepPublic, mockAudit, mockLogError } = vi.hoisted(() => ({
  mockDue: vi.fn(),
  mockUnfinished: vi.fn(),
  mockExecute: vi.fn(),
  mockSweepPublic: vi.fn(),
  mockAudit: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({ validateSignedCronRequest: vi.fn() }));
vi.mock('@pagespace/lib/content-safety/case-store', () => ({ listCasesDueForResweep: mockDue, listUnfinishedGlobalCases: mockUnfinished }));
vi.mock('@/lib/content-safety/takedown-service', () => ({ executeTakedown: mockExecute, sweepPublicForUnfinishedCase: mockSweepPublic }));
vi.mock('@pagespace/lib/content-safety/takedown', () => ({ MAX_RESWEEP_ATTEMPTS: 3 }));
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
    mockUnfinished.mockResolvedValue([]);
    mockExecute.mockResolvedValue({ action: 'resweep', status: 'actioned' });
    mockSweepPublic.mockResolvedValue({ swept: true, deleted: 0 });
  });

  describe('unfinished takedowns', () => {
    it('takes the public copies offline again for every unfinished case of the last day, every tick', async () => {
      mockUnfinished.mockResolvedValue([{ id: 'halt-1' }, { id: 'halt-2' }]);
      mockSweepPublic.mockResolvedValueOnce({ swept: true, deleted: 1 }).mockResolvedValueOnce({ swept: false });
      const before = Date.now();

      const response = await GET(request());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, due: 0, swept: 0, unfinished: 2, unfinishedPublicDeleted: 1 });
      expect(mockSweepPublic.mock.calls).toEqual([['halt-1'], ['halt-2']]);
      const { notOlderThan } = mockUnfinished.mock.calls[0][0] as { notOlderThan: Date };
      expect(before - notOlderThan.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5);
    });

    it('answers 500 when an unfinished case\'s public copies could not be taken down', async () => {
      mockUnfinished.mockResolvedValue([{ id: 'halt-1' }]);
      mockSweepPublic.mockResolvedValue({ swept: true, error: 'publish bucket down' });

      const response = await GET(request());

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false, failedCaseIds: ['halt-1'] });
    });
  });

  it('refuses an unsigned request and sweeps nothing', async () => {
    vi.mocked(validateSignedCronRequest).mockReturnValue(new Response('no', { status: 401 }) as never);

    expect((await GET(request())).status).toBe(401);
    expect(mockDue).not.toHaveBeenCalled();
  });

  it('asks for cases quiet since the presigned-PUT window closed, within the last day, under the attempt cap', async () => {
    const before = Date.now();
    await GET(request());

    const { quietBefore, notOlderThan, maxAttempts } = mockDue.mock.calls[0][0] as { quietBefore: Date; notOlderThan: Date; maxAttempts: number };
    expect(before - quietBefore.getTime()).toBeGreaterThanOrEqual(20 * 60 * 1000 - 5);
    expect(before - notOlderThan.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5);
    expect(maxAttempts).toBe(3);
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
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'content_safety_resweep', details: { due: 2, swept: 2, failed: 0, inProgress: 0, unfinished: 0, unfinishedPublicDeleted: 0 } }));
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

  it('counts a case another run is already sweeping as neither swept nor failed: this tick did nothing to it', async () => {
    mockDue.mockResolvedValue([{ id: 'case-1' }, { id: 'case-2' }]);
    mockExecute
      .mockResolvedValueOnce({ action: 'resweep', caseId: 'case-1', status: 'open', inProgress: true })
      .mockResolvedValueOnce({ action: 'resweep', caseId: 'case-2', status: 'actioned', inProgress: true });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, due: 2, swept: 0, inProgress: 2 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ details: { due: 2, swept: 0, failed: 0, inProgress: 2, unfinished: 0, unfinishedPublicDeleted: 0 } }));
  });
});
