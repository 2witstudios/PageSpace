import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: (handler: (admin: { id: string }, req: Request) => Promise<Response>) =>
    (req: Request) => handler({ id: 'admin-1' }, req),
}));

const { listMock, attachMock, getMock, closeMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  attachMock: vi.fn(),
  getMock: vi.fn(),
  closeMock: vi.fn(),
}));
vi.mock('@pagespace/lib/content-safety/report-store', () => {
  class ReportedCaseNotFoundError extends Error {}
  class ReportedCaseChangedError extends Error {}
  return { listReportedCases: listMock, attachReports: attachMock, closeReportedCase: closeMock, ReportedCaseNotFoundError, ReportedCaseChangedError };
});
vi.mock('@pagespace/lib/content-safety/case-store', () => ({ getContentCase: getMock }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { GET, POST } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { ReportedCaseChangedError, ReportedCaseNotFoundError } from '@pagespace/lib/content-safety/report-store';

const caseRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'case-r',
  targetType: 'page',
  targetId: 'page_1',
  contentHash: null,
  status: 'reported',
  category: null,
  reason: null,
  reporterUserId: 'user_r',
  reporterContact: null,
  snapshot: {},
  steps: [],
  createdAt: new Date('2026-11-12T00:00:00.000Z'),
  updatedAt: new Date('2026-11-12T00:01:00.000Z'),
  ...overrides,
});
const reportRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'rep-1',
  caseId: 'case-r',
  category: 'harassment',
  description: '<script>alert(1)</script> see https://evil.test',
  source: 'anonymous',
  reporterUserId: null,
  contactEmail: 'me@example.com',
  createdAt: new Date('2026-11-12T00:00:30.000Z'),
  ...overrides,
});

const get = (query = '') => GET(new Request(`http://localhost/api/admin/content/reports${query}`));
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/admin/content/reports', { method: 'POST', body: JSON.stringify(body) }));

describe('GET /api/admin/content/reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue([{ case: caseRow(), reportCount: 3, reports: [reportRow()] }]);
  });

  it('lists the cases under review with their report count and reports, the text as stored', async () => {
    const body = await (await get()).json();
    expect(listMock).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    expect(body.cases).toHaveLength(1);
    const [item] = body.cases;
    expect(item.case).toMatchObject({ id: 'case-r', status: 'reported', targetType: 'page', targetId: 'page_1' });
    expect(item.reportCount).toBe(3);
    expect(item.reports).toEqual([
      {
        id: 'rep-1',
        category: 'harassment',
        source: 'anonymous',
        reporterUserId: null,
        contactEmail: 'me@example.com',
        description: '<script>alert(1)</script> see https://evil.test',
        createdAt: '2026-11-12T00:00:30.000Z',
      },
    ]);
    expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ eventType: 'content.case.read', resourceId: 'reports' }));
  });

  it('returns one case with its reports when linked by ID', async () => {
    getMock.mockResolvedValue(caseRow());
    attachMock.mockResolvedValue([{ case: caseRow(), reportCount: 1, reports: [reportRow()] }]);
    const body = await (await get('?id=case-r')).json();
    expect(attachMock).toHaveBeenCalledWith([expect.objectContaining({ id: 'case-r' })]);
    expect(body.cases[0].reports).toHaveLength(1);
  });

  it('answers 404 for an unknown case ID', async () => {
    getMock.mockResolvedValue(null);
    expect((await get('?id=nope')).status).toBe(404);
  });
});

describe('POST /api/admin/content/reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeMock.mockResolvedValue(caseRow({ status: 'dismissed' }));
  });

  it('dismisses a case under review and audits it as resolved', async () => {
    const res = await post({ caseId: 'case-r', outcome: 'dismissed', expectedReportCount: 2, note: 'not a violation' });
    expect(res.status).toBe(200);
    expect(closeMock).toHaveBeenCalledWith({ caseId: 'case-r', outcome: 'dismissed', actorUserId: 'admin-1', expectedReportCount: 2, note: 'not a violation' });
    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'content.report.resolved', userId: 'admin-1', resourceId: 'case-r', details: { outcome: 'dismissed' } }),
    );
  });

  it('refuses an unknown outcome', async () => {
    expect((await post({ caseId: 'case-r', outcome: 'deleted', expectedReportCount: 1 })).status).toBe(400);
    expect((await post({ caseId: 'case-r', outcome: 'dismissed' })).status).toBe(400);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('answers 404 for a case that is no longer under review', async () => {
    closeMock.mockRejectedValue(new ReportedCaseNotFoundError('case-r'));
    expect((await post({ caseId: 'case-r', outcome: 'actioned', expectedReportCount: 1 })).status).toBe(404);
  });

  it('answers 409 when reports arrived that the admin has not seen', async () => {
    closeMock.mockRejectedValue(new ReportedCaseChangedError('case-r'));
    const res = await post({ caseId: 'case-r', outcome: 'dismissed', expectedReportCount: 1 });
    expect(res.status).toBe(409);
    expect(auditRequest).not.toHaveBeenCalled();
  });
});
