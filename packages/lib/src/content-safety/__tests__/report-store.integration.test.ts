/**
 * The report store against REAL Postgres: a report opens a case under review,
 * further reports on the same target join it (also when they arrive at once),
 * the case category follows the CSAM-wins rule, and closing a case lets the next
 * report open a fresh one.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { contentCases, contentReports } from '@pagespace/db/schema/content-safety';
import { closeReportedCase, fileContentReport, listReportedCases, ReportedCaseNotFoundError } from '../report-store';
import type { FileReportInput } from '../report-intake';

const caseIds = new Set<string>();

const input = (targetId: string, overrides: Partial<FileReportInput> = {}): FileReportInput => ({
  target: { targetType: 'page', targetId, contentHash: null },
  category: 'other',
  description: 'it is bad',
  source: 'anonymous',
  reporterUserId: null,
  contactEmail: null,
  ...overrides,
});

async function file(value: FileReportInput) {
  const filed = await fileContentReport(value);
  caseIds.add(filed.caseId);
  return filed;
}

afterAll(async () => {
  const ids = [...caseIds];
  if (ids.length === 0) return;
  await db.delete(contentReports).where(inArray(contentReports.caseId, ids));
  await db.delete(contentCases).where(inArray(contentCases.id, ids));
});

describe('report store', () => {
  it('opens a reported case and attaches later reports to it with a running count', async () => {
    const target = `page_${createId()}`;
    const first = await file(input(target, { category: 'copyright', reporterUserId: null, contactEmail: 'me@example.com' }));
    const second = await file(input(target, { category: 'harassment', source: 'signed_in', reporterUserId: 'user_r', contactEmail: null }));

    expect(first).toEqual({ caseId: expect.any(String), created: true, reportCount: 1 });
    expect(second).toEqual({ caseId: first.caseId, created: false, reportCount: 2 });

    const [listed] = (await listReportedCases({ limit: 200 })).filter((c) => c.case.id === first.caseId);
    expect(listed.case.status).toBe('reported');
    expect(listed.case.targetId).toBe(target);
    expect(listed.case.reporterUserId).toBeNull();
    expect(listed.reports.map((r) => [r.category, r.reporterUserId, r.contactEmail])).toEqual([
      ['harassment', 'user_r', null],
      ['copyright', null, 'me@example.com'],
    ]);
  });

  it('puts reports that arrive at the same moment on one case', async () => {
    const target = `page_${createId()}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => file(input(target))));
    expect(new Set(results.map((r) => r.caseId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.map((r) => r.reportCount).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('gives the case the CSAM category as soon as any report says CSAM, and never takes it back', async () => {
    const target = `page_${createId()}`;
    const { caseId } = await file(input(target, { category: 'copyright' }));
    await file(input(target, { category: 'csam' }));
    await file(input(target, { category: 'malware' }));
    const [row] = await db.select().from(contentCases).where(inArray(contentCases.id, [caseId]));
    expect(row.category).toBe('csam');
  });

  it('lists CSAM cases first', async () => {
    const plain = await file(input(`page_${createId()}`, { category: 'other' }));
    const csam = await file(input(`page_${createId()}`, { category: 'csam' }));
    const order = (await listReportedCases({ limit: 200 })).map((c) => c.case.id);
    expect(order.indexOf(csam.caseId)).toBeLessThan(order.indexOf(plain.caseId));
  });

  it('closes a reported case, and the next report on the target opens a new one', async () => {
    const target = `page_${createId()}`;
    const { caseId } = await file(input(target));
    const closed = await closeReportedCase({ caseId, outcome: 'dismissed', actorUserId: 'admin_1', note: 'not a violation' });
    expect(closed.status).toBe('dismissed');
    expect(closed.snapshot?.review).toEqual({ outcome: 'dismissed', actorUserId: 'admin_1', note: 'not a violation', at: expect.any(String) });

    const again = await file(input(target));
    expect(again.created).toBe(true);
    expect(again.caseId).not.toBe(caseId);

    await expect(closeReportedCase({ caseId, outcome: 'actioned', actorUserId: 'admin_1' })).rejects.toBeInstanceOf(ReportedCaseNotFoundError);
  });
});
