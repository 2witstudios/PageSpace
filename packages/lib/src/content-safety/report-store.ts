/**
 * Content reports — the database edge: file a report on the case under review
 * for its target, list that queue for the admin console, and close a case.
 *
 * One case under review per target is enforced by a partial unique index
 * (`content_cases_reported_target_key`), so two reports arriving at once still
 * land on one case. A report never changes anything but `content_cases` and
 * `content_reports`: nothing is blocked, unpublished or deleted here.
 */

import { db } from '@pagespace/db/db';
import { and, count, desc, eq, inArray, sql } from '@pagespace/db/operators';
import { contentCases, contentReports, type ContentCase, type ContentReport } from '@pagespace/db/schema/content-safety';
import type { FiledReport, FileReportInput } from './report-intake';
import { isPrefixVisible, resolvePrefixOwner } from '../organizations/published-visibility';
import { caseCategoryAfterReport, type ClassifiedReportUrl } from './reports';

/** More reports arrived on the case than the admin saw when they closed it. */
export class ReportedCaseChangedError extends Error {
  constructor(readonly caseId: string) {
    super('New reports arrived on this case; review them before closing it');
    this.name = 'ReportedCaseChangedError';
  }
}

/** The case was not under review: it does not exist, or staff already closed it. */
export class ReportedCaseNotFoundError extends Error {
  constructor(readonly caseId: string) {
    super('No case under review with that ID');
    this.name = 'ReportedCaseNotFoundError';
  }
}

// A case can be closed between our insert losing the race and our read of the winner. Then we try again.
const MAX_ATTEMPTS = 3;

export async function fileContentReport(input: FileReportInput): Promise<FiledReport> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const filed = await db.transaction(async (tx): Promise<FiledReport | null> => {
      const [opened] = await tx
        .insert(contentCases)
        .values({
          targetType: input.target.targetType,
          targetId: input.target.targetId,
          contentHash: input.target.contentHash,
          status: 'reported',
          category: caseCategoryAfterReport(null, input.category),
          // The first reporter, by user ID. Never an IP address.
          reporterUserId: input.reporterUserId,
          snapshot: {},
          steps: [],
        })
        .onConflictDoNothing({
          target: [contentCases.targetType, contentCases.targetId],
          where: sql`${contentCases.status} = 'reported'`,
        })
        .returning();

      const caseRow =
        opened ??
        (
          await tx
            .select()
            .from(contentCases)
            .where(
              and(
                eq(contentCases.targetType, input.target.targetType),
                eq(contentCases.targetId, input.target.targetId),
                eq(contentCases.status, 'reported'),
              ),
            )
            .limit(1)
            // Serialises reports on one case, so each sees the count including its own.
            .for('update')
        )[0];
      if (!caseRow) return null;

      await tx.insert(contentReports).values({
        caseId: caseRow.id,
        category: input.category,
        description: input.description,
        source: input.source,
        reporterUserId: input.reporterUserId,
        contactEmail: input.contactEmail,
      });

      const [{ total }] = await tx.select({ total: count() }).from(contentReports).where(eq(contentReports.caseId, caseRow.id));

      if (!opened) {
        await tx
          .update(contentCases)
          .set({
            category: caseCategoryAfterReport(caseRow.category, input.category),
            contentHash: caseRow.contentHash ?? input.target.contentHash,
            updatedAt: new Date(),
          })
          .where(eq(contentCases.id, caseRow.id));
      }

      return { caseId: caseRow.id, created: Boolean(opened), reportCount: Number(total) };
    });
    if (filed) return filed;
  }
  throw new Error('Could not file the report: its case kept closing');
}

/**
 * The drive whose published site `host` serves, when that site is publicly visible: a `<label>.<publish host>`
 * subdomain or a custom domain, not held by a content-safety case and not hidden by its org's policy. Null
 * otherwise, so a report never confirms that a hidden or unpublished site exists.
 */
export async function findPublishedSiteDrive(site: { kind: ClassifiedReportUrl['kind']; host: string }): Promise<string | null> {
  const host = site.host.toLowerCase();
  const prefix = site.kind === 'publish_subdomain' ? host.split('.')[0] : host;
  const owner = await resolvePrefixOwner(prefix);
  if (!owner) return null;
  // A subdomain label must name a site, and a custom hostname a domain — never the other way round.
  if ((site.kind === 'publish_subdomain') !== (owner.kind === 'site')) return null;
  return (await isPrefixVisible(prefix)) ? owner.driveId : null;
}

export interface ReportedCase {
  case: ContentCase;
  reportCount: number;
  /** Newest first, at most `reportsPerCase`. */
  reports: ContentReport[];
}

/** The review queue: CSAM first, then the most recently reported. */
export async function listReportedCases(options: { limit?: number; offset?: number; reportsPerCase?: number } = {}): Promise<ReportedCase[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const perCase = Math.min(Math.max(options.reportsPerCase ?? 20, 1), 100);
  const rows = await db
    .select()
    .from(contentCases)
    .where(eq(contentCases.status, 'reported'))
    .orderBy(desc(sql`coalesce(${contentCases.category} = 'csam', false)`), desc(contentCases.updatedAt))
    .limit(limit)
    .offset(Math.max(options.offset ?? 0, 0));
  if (rows.length === 0) return [];
  return attachReports(rows, perCase);
}

/** Reports for cases already loaded — for one case linked from an alert, or the review queue. */
export async function attachReports(rows: ContentCase[], perCase = 20): Promise<ReportedCase[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const ranked = db
    .select({
      id: contentReports.id,
      rank: sql<number>`row_number() over (partition by ${contentReports.caseId} order by ${contentReports.createdAt} desc, ${contentReports.id} desc)`.as('rank'),
    })
    .from(contentReports)
    .where(inArray(contentReports.caseId, ids))
    .as('ranked');
  const [reports, totals] = await Promise.all([
    db
      .select({ report: contentReports })
      .from(contentReports)
      .innerJoin(ranked, eq(ranked.id, contentReports.id))
      .where(sql`${ranked.rank} <= ${perCase}`)
      .orderBy(desc(contentReports.createdAt), desc(contentReports.id)),
    db
      .select({ caseId: contentReports.caseId, total: count() })
      .from(contentReports)
      .where(inArray(contentReports.caseId, ids))
      .groupBy(contentReports.caseId),
  ]);
  const byCase = new Map<string, ContentReport[]>();
  for (const { report } of reports) byCase.set(report.caseId, [...(byCase.get(report.caseId) ?? []), report]);
  const totalByCase = new Map(totals.map((row) => [row.caseId, Number(row.total)]));
  return rows.map((row) => ({ case: row, reportCount: totalByCase.get(row.id) ?? 0, reports: byCase.get(row.id) ?? [] }));
}

/**
 * Close a case under review. `actioned`: staff acted on it (a takedown runs as
 * its own case). `dismissed`: no violation. Either way the next report on the
 * target opens a fresh case.
 */
export async function closeReportedCase(input: {
  caseId: string;
  outcome: 'dismissed' | 'actioned';
  actorUserId: string;
  /** How many reports the admin saw. The close is refused if more have arrived since. */
  expectedReportCount: number;
  note?: string;
}): Promise<ContentCase> {
  const review = { outcome: input.outcome, actorUserId: input.actorUserId, note: input.note, at: new Date().toISOString() };
  return db.transaction(async (tx) => {
    // The same row lock a report takes to attach, so a report lands either before the count check or on a new case.
    const [locked] = await tx
      .select({ id: contentCases.id })
      .from(contentCases)
      .where(and(eq(contentCases.id, input.caseId), eq(contentCases.status, 'reported')))
      .limit(1)
      .for('update');
    if (!locked) throw new ReportedCaseNotFoundError(input.caseId);
    const [{ total }] = await tx.select({ total: count() }).from(contentReports).where(eq(contentReports.caseId, input.caseId));
    if (Number(total) !== input.expectedReportCount) throw new ReportedCaseChangedError(input.caseId);
    const [row] = await tx
      .update(contentCases)
      .set({
        status: input.outcome,
        snapshot: sql`coalesce(${contentCases.snapshot}, '{}'::jsonb) || ${JSON.stringify({ review })}::jsonb`,
      })
      .where(eq(contentCases.id, input.caseId))
      .returning();
    return row;
  });
}
