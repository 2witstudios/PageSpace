import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: (handler: (admin: { id: string }, req: Request) => Promise<Response>) =>
    (req: Request) => handler({ id: 'admin-1' }, req),
}));

const { callWebTakedownMock, getContentCaseMock } = vi.hoisted(() => ({
  callWebTakedownMock: vi.fn(),
  getContentCaseMock: vi.fn(),
}));
vi.mock('@/lib/content/web-takedown', () => ({ callWebTakedown: callWebTakedownMock }));
vi.mock('@pagespace/lib/content-safety/case-store', () => ({ getContentCase: getContentCaseMock }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { POST } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const HASH = 'a'.repeat(64);
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/admin/content/takedown', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
const ok = (body: Record<string, unknown>) => ({ ok: true, status: 200, body });
const lastAudit = () => vi.mocked(auditRequest).mock.calls.at(-1)![1];

describe('POST /api/admin/content/takedown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callWebTakedownMock.mockResolvedValue(ok({ action: 'global', caseId: 'case-1', status: 'actioned' }));
    getContentCaseMock.mockResolvedValue(null);
  });

  describe('global takedown', () => {
    const body = { action: 'global', contentHash: HASH, category: 'csam', reason: 'NCMEC hash match' };

    it('proxies to the web app as the acting admin and returns the result', async () => {
      const res = await post(body);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ action: 'global', caseId: 'case-1', status: 'actioned' });
      expect(callWebTakedownMock).toHaveBeenCalledWith(body, 'admin-1');
    });

    it('audits it as content.takedown.global with the category, the reason and the outcome', async () => {
      await post({ ...body, suspendUploader: true });

      expect(lastAudit()).toMatchObject({
        eventType: 'content.takedown.global',
        userId: 'admin-1',
        resourceType: 'file',
        resourceId: HASH,
        details: {
          action: 'global',
          category: 'csam',
          reason: 'NCMEC hash match',
          suspendUploader: true,
          skipPreservation: false,
          outcome: 'completed',
          caseId: 'case-1',
          status: 'actioned',
        },
      });
    });

    it('audits the reason given for skipping preservation', async () => {
      await post({ ...body, category: 'malware', skipPreservation: true, skipPreservationReason: 'known sample, vendor has it' });

      expect(lastAudit().details).toMatchObject({ skipPreservation: true, skipPreservationReason: 'known sample, vendor has it' });
    });

    it('audits a case that stopped at the evidence step as that, not as completed', async () => {
      callWebTakedownMock.mockResolvedValue(ok({ action: 'global', caseId: 'case-1', status: 'awaiting_evidence', haltReason: 'awaiting_evidence' }));
      await post(body);
      expect(lastAudit().details).toMatchObject({ outcome: 'awaiting_evidence', status: 'awaiting_evidence' });
    });

    it('audits a request that found another run of the case under way as that, not as completed', async () => {
      callWebTakedownMock.mockResolvedValue(ok({ action: 'global', caseId: 'case-1', status: 'open', inProgress: true }));
      await post(body);
      expect(lastAudit().details).toMatchObject({ outcome: 'in_progress', status: 'open' });
    });

    it('audits a failed step and still returns the case so the UI can offer resume', async () => {
      callWebTakedownMock.mockResolvedValue(ok({ action: 'global', caseId: 'case-1', status: 'open', failedStep: 'delete_public', error: 'S3 down' }));
      const res = await post(body);

      expect(res.status).toBe(200);
      expect(lastAudit().details).toMatchObject({ outcome: 'step_failed', failedStep: 'delete_public' });
    });

    it('audits an attempt the web app never ran', async () => {
      callWebTakedownMock.mockResolvedValue({ ok: false, status: 502, error: 'Failed to reach the web app.' });
      const res = await post(body);

      expect(res.status).toBe(502);
      expect(lastAudit()).toMatchObject({ eventType: 'content.takedown.global', details: { outcome: 'not_run', upstreamStatus: 502 } });
    });
  });

  it.each([
    [{ action: 'unpublish_page', pageId: 'page-1', category: 'policy', reason: 'DMCA' }, 'content.takedown.page_unpublished', 'page', 'page-1'],
    [{ action: 'park_drive', driveId: 'drive-1', category: 'policy', reason: 'terms' }, 'content.takedown.sites_parked', 'drive', 'drive-1'],
    [{ action: 'restore_drive', caseId: 'case-3', reason: 'counter-notice' }, 'content.takedown.sites_restored', 'content_case', 'case-3'],
    [{ action: 'avatar', userId: 'user-1', category: 'csam', reason: 'report' }, 'content.takedown.avatar', 'user', 'user-1'],
    [{ action: 'resweep', caseId: 'case-1' }, 'content.takedown.global', 'content_case', 'case-1'],
  ])('audits %j under its own event type', async (body, eventType, resourceType, resourceId) => {
    await post(body);
    expect(lastAudit()).toMatchObject({ eventType, resourceType, resourceId, userId: 'admin-1' });
  });

  it('audits a restore that left the drive parked as exactly that', async () => {
    callWebTakedownMock.mockResolvedValue(ok({ action: 'restore_drive', caseId: 'case-3', status: 'actioned', restoredDriveIds: [], stillHeldDriveIds: ['drive-1'] }));
    await post({ action: 'restore_drive', caseId: 'case-3', reason: 'counter-notice' });

    expect(lastAudit().details).toMatchObject({
      reason: 'counter-notice',
      outcome: 'hold_lifted_drive_still_held',
      stillHeldDriveIds: ['drive-1'],
    });
  });

  it('refuses a restore that names no case: a hold is lifted by the case that placed it', async () => {
    const res = await post({ action: 'restore_drive', driveId: 'drive-1', reason: 'counter-notice' });
    expect(res.status).toBe(400);
    expect(callWebTakedownMock).not.toHaveBeenCalled();
  });

  it('audits a resume as the action of the case it continues', async () => {
    getContentCaseMock.mockResolvedValue({ id: 'case-7', snapshot: { takedown: { kind: 'avatar' } } });
    await post({ action: 'resume', caseId: 'case-7' });

    expect(lastAudit()).toMatchObject({ eventType: 'content.takedown.avatar', resourceType: 'content_case', resourceId: 'case-7' });
  });

  describe('validation — nothing is proxied or audited', () => {
    it.each([
      ['a body that is not JSON', 'nope'],
      ['no category', { action: 'unpublish_page', pageId: 'page-1', reason: 'r' }],
      ['no reason', { action: 'global', contentHash: HASH, category: 'csam' }],
      ['a blank reason', { action: 'avatar', userId: 'user-1', category: 'csam', reason: '  ' }],
      ['a global takedown under the policy category', { action: 'global', contentHash: HASH, category: 'policy', reason: 'r' }],
      ['skipping preservation for CSAM', { action: 'global', contentHash: HASH, category: 'csam', reason: 'r', skipPreservation: true, skipPreservationReason: 'x' }],
      ['an unknown action', { action: 'purge_all' }],
    ])('rejects %s', async (_label, body) => {
      const res = await post(body);

      expect(res.status).toBe(400);
      expect(callWebTakedownMock).not.toHaveBeenCalled();
      expect(auditRequest).not.toHaveBeenCalled();
    });
  });

  it('refuses an avatar takedown on the admin\'s own account', async () => {
    const res = await post({ action: 'avatar', userId: 'admin-1', category: 'policy', reason: 'r' });
    expect(res.status).toBe(400);
    expect(callWebTakedownMock).not.toHaveBeenCalled();
  });
});
