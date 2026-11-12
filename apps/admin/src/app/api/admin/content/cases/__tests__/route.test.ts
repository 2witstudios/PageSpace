import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: (handler: (admin: { id: string }, req: Request) => Promise<Response>) =>
    (req: Request) => handler({ id: 'admin-1' }, req),
}));

const { listMock, getMock } = vi.hoisted(() => ({ listMock: vi.fn(), getMock: vi.fn() }));
vi.mock('@pagespace/lib/content-safety/case-store', () => ({ listContentCases: listMock, getContentCase: getMock }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { GET } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const HASH = 'a'.repeat(64);
const get = (query = '') => GET(new Request(`http://localhost/api/admin/content/cases${query}`));

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'case-1',
  targetType: 'content_hash',
  targetId: HASH,
  contentHash: HASH,
  status: 'open',
  category: 'malware',
  reason: 'reported sample',
  reporterUserId: null,
  reporterContact: null,
  snapshot: {
    takedown: { kind: 'global', actorUserId: 'admin-9' },
    references: {
      pageIds: ['p1', 'p2'], fileIds: [HASH], driveIds: ['d1'], uploaderUserIds: ['u1'],
      channelMessageIds: ['m1'], directMessageIds: ['m2'], aiMessageIds: ['m3'], conversationIds: ['c1'], truncated: false,
    },
  },
  steps: [
    { step: 'block', status: 'ok', at: 't1' },
    { step: 'preserve', status: 'ok', at: 't2' },
    { step: 'delete_uploads', status: 'failed', detail: 'S3 down', at: 't3' },
  ],
  createdAt: new Date('2026-11-12T00:00:00.000Z'),
  updatedAt: new Date('2026-11-12T00:01:00.000Z'),
  ...overrides,
});

describe('GET /api/admin/content/cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue([row()]);
    getMock.mockResolvedValue(row());
  });

  it('lists cases with status, step progress and whether they can be resumed', async () => {
    const body = await (await get()).json();

    expect(listMock).toHaveBeenCalledWith({ status: undefined, limit: 50, offset: 0 });
    expect(body.cases[0]).toMatchObject({
      id: 'case-1',
      status: 'open',
      category: 'malware',
      actorUserId: 'admin-9',
      progress: {
        kind: 'global',
        resumable: true,
        resweepable: false,
        steps: [
          { step: 'block', status: 'ok' },
          { step: 'preserve', status: 'ok' },
          { step: 'delete_uploads', status: 'failed', detail: 'S3 down' },
          { step: 'delete_public', status: 'pending' },
          { step: 'record_references', status: 'pending' },
        ],
      },
      references: { pageIds: ['p1', 'p2'], driveIds: ['d1'], uploaderUserIds: ['u1'], messageCount: 3, truncated: false },
    });
  });

  it('filters by status and pages', async () => {
    await get('?status=awaiting_evidence&limit=10&offset=20');
    expect(listMock).toHaveBeenCalledWith({ status: 'awaiting_evidence', limit: 10, offset: 20 });
  });

  it('treats "all" as no filter and rejects an unknown status', async () => {
    await get('?status=all');
    expect(listMock).toHaveBeenCalledWith({ status: undefined, limit: 50, offset: 0 });
    expect((await get('?status=bogus')).status).toBe(400);
  });

  it('returns one case by ID, for the link in an alert email', async () => {
    const res = await get('?id=case-1');

    expect(getMock).toHaveBeenCalledWith('case-1');
    expect((await res.json()).cases).toHaveLength(1);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('answers 404 for a case ID that does not exist', async () => {
    getMock.mockResolvedValue(null);
    expect((await get('?id=missing')).status).toBe(404);
  });

  it('shows a finished global case as re-sweepable, not resumable', async () => {
    listMock.mockResolvedValue([row({ status: 'actioned' })]);
    const body = await (await get()).json();
    expect(body.cases[0].progress).toMatchObject({ resumable: false, resweepable: true });
  });

  it('carries the drives a suspension left unparked', async () => {
    listMock.mockResolvedValue([
      row({
        targetType: 'user',
        targetId: 'u1',
        contentHash: null,
        snapshot: { takedown: { kind: 'park_user_sites' }, driveIds: ['d1'], skippedDrives: [{ driveId: 'd2', reason: 'org_drive_with_other_members' }] },
        steps: [{ step: 'park_sites', status: 'ok', at: 't' }],
        status: 'actioned',
      }),
    ]);
    const body = await (await get()).json();

    expect(body.cases[0].skippedDrives).toEqual([{ driveId: 'd2', reason: 'org_drive_with_other_members' }]);
    expect(body.cases[0].references.driveIds).toEqual(['d1']);
  });

  it('audits the read', async () => {
    await get();
    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'content.case.read', userId: 'admin-1', details: expect.objectContaining({ action: 'list_cases', count: 1 }) }),
    );
  });
});
