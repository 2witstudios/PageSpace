import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: (handler: (admin: { id: string }, req: Request) => Promise<Response>) =>
    (req: Request) => handler({ id: 'admin-1' }, req),
}));

const { resolveMock, listCasesMock } = vi.hoisted(() => ({ resolveMock: vi.fn(), listCasesMock: vi.fn() }));
vi.mock('@pagespace/lib/content-safety/targets', () => ({ resolveTakedownTarget: resolveMock }));
vi.mock('@pagespace/lib/content-safety/case-store', () => ({ listCasesForTarget: listCasesMock }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { GET } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const HASH = 'a'.repeat(64);
const get = (q?: string) =>
  GET(new Request(`http://localhost/api/admin/content/resolve${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`));

const TARGET = {
  targetType: 'page',
  targetId: 'page-1',
  contentHash: HASH,
  block: null,
  page: { id: 'page-1', driveId: 'drive-1', type: 'FILE', mimeType: 'image/png', isPublished: true, isTrashed: false },
  drive: { id: 'drive-1', ownerId: 'user-1', orgId: null, publishes: true, sitesHeld: false },
  user: null,
  references: {
    pageIds: ['page-1'], fileIds: [HASH], driveIds: ['drive-1'], uploaderUserIds: ['user-1'],
    channelMessageIds: [], directMessageIds: [], aiMessageIds: [], conversationIds: [], truncated: false,
  },
};

const CASE = {
  id: 'case-1',
  targetType: 'content_hash',
  targetId: HASH,
  contentHash: HASH,
  status: 'open',
  category: 'csam',
  reason: 'reported',
  reporterUserId: null,
  reporterContact: null,
  snapshot: {
    takedown: { kind: 'global', actorUserId: 'admin-1' },
    evidenceKey: `cases/case-1/${HASH}/original`,
    ipAddress: '203.0.113.9',
    userAgent: 'curl',
  },
  steps: [{ step: 'block', status: 'ok', at: '2026-11-12T00:00:00.000Z' }],
  createdAt: new Date('2026-11-12T00:00:00.000Z'),
  updatedAt: new Date('2026-11-12T00:01:00.000Z'),
};

describe('GET /api/admin/content/resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveMock.mockResolvedValue(TARGET);
    listCasesMock.mockResolvedValue([CASE]);
  });

  it('returns the resolved target, its references and its case history', async () => {
    const res = await get('page-1');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(resolveMock).toHaveBeenCalledWith('page-1');
    expect(body.target).toEqual(TARGET);
    expect(listCasesMock).toHaveBeenCalledWith({ targetType: 'page', targetId: 'page-1', contentHash: HASH });
    expect(body.cases[0]).toMatchObject({
      id: 'case-1',
      status: 'open',
      category: 'csam',
      evidencePreserved: true,
      progress: { kind: 'global', resumable: true },
    });
  });

  it('never returns a way to see the file: no evidence key, storage key, title, filename or request IP', async () => {
    const json = JSON.stringify(await (await get('page-1')).json());

    expect(json).not.toContain('cases/case-1/');
    expect(json).not.toMatch(/evidenceKey|storageKey|presign|thumbnail|title|fileName|filename/i);
    expect(json).not.toContain('203.0.113.9');
    expect(json).not.toMatch(/https?:\/\//);
  });

  it('audits the lookup against the resolved target, not the raw input', async () => {
    resolveMock.mockResolvedValue({ ...TARGET, targetType: 'published_url', targetId: 'https://acme.pagespace.site/secret-page' });
    await get('https://acme.pagespace.site/secret-page');

    const event = vi.mocked(auditRequest).mock.calls[0][1];
    expect(event).toMatchObject({ eventType: 'content.case.read', userId: 'admin-1', resourceId: 'page-1' });
    expect(JSON.stringify(event)).not.toContain('secret-page');
  });

  it('answers 404 when nothing matches, and still audits the lookup', async () => {
    resolveMock.mockResolvedValue(null);
    const res = await get('nothing');

    expect(res.status).toBe(404);
    expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ details: expect.objectContaining({ found: false }) }));
  });

  it('answers 400 for an empty or oversized query', async () => {
    expect((await get()).status).toBe(400);
    expect((await get('   ')).status).toBe(400);
    expect((await get('x'.repeat(3000))).status).toBe(400);
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
