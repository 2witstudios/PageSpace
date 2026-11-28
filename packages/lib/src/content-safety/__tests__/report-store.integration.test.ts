/**
 * The report store against REAL Postgres: a report opens a case under review,
 * further reports on the same target join it (also when they arrive at once),
 * the case category follows the CSAM-wins rule, and closing a case lets the next
 * report open a fresh one.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { contentCases, contentReports, contentSiteHolds } from '@pagespace/db/schema/content-safety';
import { drives, pages } from '@pagespace/db/schema/core';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { factories } from '@pagespace/db/test/factories';
import {
  attachReports,
  closeReportedCase,
  fileContentReport,
  findPublishedSiteDrive,
  getReportedCase,
  listCaseReports,
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

  it('reads the reports it shows and the count it reports in ONE statement, so the count never covers a report it left out', async () => {
    const { caseId } = await file(input(`page_${createId()}`));
    const [row] = await db.select().from(contentCases).where(eq(contentCases.id, caseId));
    const query = vi.spyOn(pool, 'query');
    try {
      const [withReports] = await attachReports([row]);
      expect(withReports.reportCount).toBe(1);
      expect(withReports.reports).toHaveLength(1);
      // Two statements would each take their own snapshot: a report committed between them would be
      // counted (and acknowledged by a close) without ever being shown.
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
  });

  it('reads the queue\'s cases and their reports in one repeatable-read snapshot, so a case row never lags its reports', async () => {
    const { caseId } = await file(input(`page_${createId()}`, { category: 'csam' }));
    const transaction = vi.spyOn(db, 'transaction');
    try {
      const queue = await listReportedCases({ limit: 200 });
      expect(queue.find((c) => c.case.id === caseId)?.reportCount).toBe(1);
      const one = await getReportedCase(caseId);
      expect(one?.case.category).toBe('csam');
      expect(one?.reports).toHaveLength(1);
      expect(transaction).toHaveBeenCalledTimes(2);
      for (const call of transaction.mock.calls) expect(call[1]).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
    } finally {
      transaction.mockRestore();
    }
    expect(await getReportedCase(`case_${createId()}`)).toBeNull();
  });

  it('pages through every report on a case, oldest last, past the first page the queue shows', async () => {
    const target = `page_${createId()}`;
    let caseId = '';
    for (let i = 0; i < 25; i++) ({ caseId } = await file(input(target, { description: `report ${i}` })));
    const [row] = await db.select().from(contentCases).where(eq(contentCases.id, caseId));

    const [firstPage] = await attachReports([row]);
    expect(firstPage.reportCount).toBe(25);
    expect(firstPage.reports.map((r) => r.description)).toEqual(Array.from({ length: 20 }, (_, i) => `report ${24 - i}`));

    const last = firstPage.reports[firstPage.reports.length - 1];
    // A report filed while the admin is paging shifts nothing: the page is keyed on the last report shown.
    await file(input(target, { description: 'filed meanwhile' }));
    const rest = await listCaseReports(caseId, { beforeId: last.id, limit: 20 });
    expect(rest.map((r) => r.description)).toEqual(['report 4', 'report 3', 'report 2', 'report 1', 'report 0']);
    expect(await listCaseReports(caseId, { beforeId: rest[rest.length - 1].id, limit: 20 })).toEqual([]);
    // A report ID from another case pages nothing.
    expect(await listCaseReports(`case_${createId()}`, { beforeId: last.id, limit: 20 })).toEqual([]);
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

  it('finds the drive of a custom domain only while the domain serves the site, not while it is pending', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const host = `rp-${createId().slice(0, 8).toLowerCase()}.example.com`;
    const [domain] = await db.insert(customDomains).values({ driveId: drive.id, hostname: host, status: 'pending' }).returning();
    try {
      expect(await findPublishedSiteDrive({ kind: 'custom_domain_candidate', host })).toBeNull();
      await db.update(customDomains).set({ status: 'verified' }).where(eq(customDomains.id, domain.id));
      expect(await findPublishedSiteDrive({ kind: 'custom_domain_candidate', host })).toBe(drive.id);
      await db.update(customDomains).set({ status: 'dns_failed' }).where(eq(customDomains.id, domain.id));
      expect(await findPublishedSiteDrive({ kind: 'custom_domain_candidate', host })).toBeNull();
    } finally {
      await db.delete(customDomains).where(eq(customDomains.id, domain.id));
      await db.delete(drives).where(eq(drives.id, drive.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });

  it('files a report on a custom domain\'s root against the landing page that domain serves, not the drive home page', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const home = await factories.createPage(drive.id, { title: 'home' });
    const landing = await factories.createPage(drive.id, { title: 'landing' });
    for (const page of [home, landing]) {
      await db.insert(publishedPages).values({ driveId: drive.id, pageId: page.id, path: page.title.toLowerCase(), artifactKey: `k/${page.id}` });
    }
    await db.update(drives).set({ homePageId: home.id }).where(eq(drives.id, drive.id));
    const host = `rp-${createId().slice(0, 8).toLowerCase()}.example.com`;
    const [domain] = await db.insert(customDomains).values({ driveId: drive.id, hostname: host, status: 'active', publishLandingPageId: landing.id }).returning();
    try {
      expect((await resolveTakedownTarget(`https://${host}/`))?.targetId).toBe(landing.id);
      // A domain with no landing page of its own serves the drive's home page.
      await db.update(customDomains).set({ publishLandingPageId: null }).where(eq(customDomains.id, domain.id));
      expect((await resolveTakedownTarget(`https://${host}/`))?.targetId).toBe(home.id);
    } finally {
      await db.delete(customDomains).where(eq(customDomains.id, domain.id));
      await db.delete(publishedPages).where(eq(publishedPages.driveId, drive.id));
      await db.update(drives).set({ homePageId: null }).where(eq(drives.id, drive.id));
      await db.delete(pages).where(inArray(pages.id, [home.id, landing.id]));
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
