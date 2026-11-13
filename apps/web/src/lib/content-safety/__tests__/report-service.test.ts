import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReportAuditEvent, ReportIntakeDeps } from '@pagespace/lib/content-safety/report-intake';

const { audit, auditRequest, submitContentReport } = vi.hoisted(() => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
  submitContentReport: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit, auditRequest }));
vi.mock('@pagespace/lib/content-safety/report-intake', () => ({ submitContentReport }));
vi.mock('@pagespace/lib/content-safety/alerts', () => ({ sendContentSafetyAlert: vi.fn() }));
vi.mock('@pagespace/lib/content-safety/report-store', () => ({ fileContentReport: vi.fn(), findPublishedSiteDrive: vi.fn() }));
vi.mock('@pagespace/lib/content-safety/targets', () => ({ resolveTakedownTarget: vi.fn() }));
vi.mock('@pagespace/lib/permissions/file-access', () => ({ canUserAccessFile: vi.fn() }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ canUserViewPage: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@/lib/canvas/publish-page', () => ({ PUBLISH_HOST: 'pagespace.site' }));

import { fileReport } from '../report-service';

const event = (overrides: Partial<ReportAuditEvent> = {}): ReportAuditEvent => ({
  eventType: 'content.report.created', caseId: 'case_1', category: 'csam', reportCount: 1,
  source: 'anonymous', reporterUserId: null, targetType: 'page', ...overrides,
});

async function depsFor(actor: { userId: string } | null): Promise<ReportIntakeDeps> {
  submitContentReport.mockResolvedValue({ ok: true, filed: false, csamGuidance: null });
  const request = new Request('http://localhost/api/report', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.7' } });
  await fileReport(request, actor as never, { reporter: { kind: 'anonymous' }, target: { type: 'published_url', url: 'https://a.pagespace.site/' }, category: 'csam' });
  return submitContentReport.mock.calls[0][1] as ReportIntakeDeps;
}

describe('report-service audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('audits an anonymous report without the IP or user agent', async () => {
    const deps = await depsFor(null);
    deps.audit(event());
    expect(auditRequest).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = audit.mock.calls[0][0];
    expect(entry).not.toHaveProperty('ipAddress');
    expect(entry).not.toHaveProperty('userAgent');
    expect(JSON.stringify(entry)).not.toContain('203.0.113.7');
    expect(entry).toMatchObject({ eventType: 'content.report.created', resourceId: 'case_1', details: { category: 'csam', reportCount: 1, source: 'anonymous', targetType: 'page' } });
  });

  it('attributes a signed-in report through the request as usual', async () => {
    const deps = await depsFor({ userId: 'user_r' });
    deps.audit(event({ source: 'signed_in', reporterUserId: 'user_r', eventType: 'content.report.attached' }));
    expect(audit).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ userId: 'user_r', eventType: 'content.report.attached' }));
  });
});
