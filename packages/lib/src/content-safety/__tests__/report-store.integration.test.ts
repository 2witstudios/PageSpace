/**
 * The report store against REAL Postgres: a report opens a case under review,
 * further reports on the same target join it (also when they arrive at once),
 * the case category follows the CSAM-wins rule, and closing a case lets the next
 * report open a fresh one.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { contentCases, contentReports, contentSiteHolds } from '@pagespace/db/schema/content-safety';
import { drives } from '@pagespace/db/schema/core';
import { factories } from '@pagespace/db/test/factories';
import {
  closeReportedCase,
  fileContentReport,
  findPublishedSiteDrive,
  listReportedCases,
  ReportedCaseChangedError,
  ReportedCaseNotFoundError,
} from '../report-store';
import { submitContentReport, type FileReportInput, type ReportIntakeDeps } from '../report-intake';
import { resolveTakedownTarget } from '../targets';

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
    const closed = await closeReportedCase({ caseId, outcome: 'dismissed', actorUserId: 'admin_1', expectedReportCount: 1, note: 'not a violation' });
    expect(closed.status).toBe('dismissed');
    expect(closed.snapshot?.review).toEqual({ outcome: 'dismissed', actorUserId: 'admin_1', note: 'not a violation', at: expect.any(String) });

    const again = await file(input(target));
    expect(again.created).toBe(true);
    expect(again.caseId).not.toBe(caseId);

    await expect(closeReportedCase({ caseId, outcome: 'actioned', actorUserId: 'admin_1', expectedReportCount: 1 })).rejects.toBeInstanceOf(
      ReportedCaseNotFoundError,
    );
  });

  it('refuses to close a case that received reports the admin has not seen', async () => {
    const target = `page_${createId()}`;
    const { caseId } = await file(input(target));
    await file(input(target));
    await expect(closeReportedCase({ caseId, outcome: 'dismissed', actorUserId: 'admin_1', expectedReportCount: 1 })).rejects.toBeInstanceOf(
      ReportedCaseChangedError,
    );
    const closed = await closeReportedCase({ caseId, outcome: 'dismissed', actorUserId: 'admin_1', expectedReportCount: 2 });
    expect(closed.status).toBe('dismissed');
  });

  it('finds the drive of a published subdomain, and nothing once the site is held', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const label = `rp-${createId().slice(0, 8).toLowerCase()}`;
    await db.update(drives).set({ publishSubdomain: label }).where(eq(drives.id, drive.id));
    try {
      expect(await findPublishedSiteDrive({ kind: 'publish_subdomain', host: `${label}.pagespace.site` })).toBe(drive.id);
      // The label as a custom hostname is not the same thing.
      expect(await findPublishedSiteDrive({ kind: 'custom_domain_candidate', host: label })).toBeNull();
      await db.insert(contentSiteHolds).values({ driveId: drive.id, holder: `case:test-${label}`, source: 'takedown' });
      expect(await findPublishedSiteDrive({ kind: 'publish_subdomain', host: `${label}.pagespace.site` })).toBeNull();
    } finally {
      await db.delete(contentSiteHolds).where(eq(contentSiteHolds.driveId, drive.id));
      await db.delete(drives).where(eq(drives.id, drive.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });

  it('finds nothing for an unknown host', async () => {
    expect(await findPublishedSiteDrive({ kind: 'publish_subdomain', host: `nobody-${createId()}.pagespace.site` })).toBeNull();
    expect(await findPublishedSiteDrive({ kind: 'custom_domain_candidate', host: `${createId()}.example.com` })).toBeNull();
  });

  it('a crafted avatar or storage path on a published host files nothing about a real user or hash (real resolver)', async () => {
    const victim = await factories.createUser();
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const label = `rp-${createId().slice(0, 8).toLowerCase()}`;
    await db.update(drives).set({ publishSubdomain: label }).where(eq(drives.id, drive.id));
    const fileReport = vi.fn();
    const deps: ReportIntakeDeps = {
      publishHost: 'pagespace.site',
      resolveTarget: resolveTakedownTarget,
      publishedSiteDrive: findPublishedSiteDrive,
      canViewPage: async () => false,
      canAccessFile: async () => false,
      fileReport,
      alert: async () => undefined,
      audit: () => undefined,
    };
    try {
      for (const host of [`${label}.pagespace.site`, `nobody-${createId().slice(0, 8)}.pagespace.site`]) {
        for (const path of [`/x/api/avatar/${victim.id}/a.png`, `//api/avatar/${victim.id}/a.png`, `/q/files/${'d'.repeat(64)}/`, `/assets/${'d'.repeat(64)}`]) {
          const outcome = await submitContentReport(
            { reporter: { kind: 'anonymous' }, target: { type: 'published_url', url: `https://${host}${path}` }, category: 'csam' },
            deps,
          );
          expect(outcome, `${host}${path}`).toEqual({ ok: false, reason: 'not_pagespace_url' });
        }
      }
      expect(fileReport).not.toHaveBeenCalled();
    } finally {
      await db.delete(drives).where(eq(drives.id, drive.id));
      await db.delete(users).where(inArray(users.id, [victim.id, owner.id]));
    }
  });
});
