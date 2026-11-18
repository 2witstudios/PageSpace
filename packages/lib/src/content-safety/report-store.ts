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
import { and, count, desc, eq, inArray, lte, or, sql } from '@pagespace/db/operators';
import { getTableColumns } from 'drizzle-orm';
import { contentBlocks, contentCases, contentReports, contentScans, type ContentCase, type ContentReport } from '@pagespace/db/schema/content-safety';
import type { FiledReport, FileReportInput } from './report-intake';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { isServingStatus } from '../canvas/cert-action';
import { isPrefixVisible, resolvePrefixOwner } from '../organizations/published-visibility';
import { caseCategoryAfterReport, type ClassifiedReportUrl } from './reports';
import { ADMIN_REVIEW_PROVIDER } from './scan-store';

/** The singleton or a transaction: anything that can run a select. */
type Executor = Pick<typeof db, 'select'>;

/** The case changed after the admin opened it: more reports arrived, or the publish scan flagged it (again). */
export class ReportedCaseChangedError extends Error {
  constructor(readonly caseId: string) {
    super('This case changed (new reports or a new scan flag); review it before closing it');
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
 * subdomain or a custom domain that is serving (DNS verified), not held by a content-safety case and not hidden by its org's policy. Null
 * otherwise, so a report never confirms that a hidden or unpublished site exists.
 */
export async function findPublishedSiteDrive(site: { kind: ClassifiedReportUrl['kind']; host: string }): Promise<string | null> {
  const host = site.host.toLowerCase();
  const prefix = site.kind === 'publish_subdomain' ? host.split('.')[0] : host;
  const owner = await resolvePrefixOwner(prefix);
  if (!owner) return null;
  // A subdomain label must name a site, and a custom hostname a domain — never the other way round.
  if ((site.kind === 'publish_subdomain') !== (owner.kind === 'site')) return null;
  // A custom domain serves the site only once its DNS is verified (the same rule the content mirror uses); a
  // pending or failed domain is not a live site yet.
  if (owner.kind !== 'site') {
    const [domain] = await db.select({ status: customDomains.status }).from(customDomains).where(eq(customDomains.hostname, prefix)).limit(1);
    if (!domain || !isServingStatus(domain.status)) return null;
  }
  return (await isPrefixVisible(prefix)) ? owner.driveId : null;
}

export interface ReportedCase {
  case: ContentCase;
  reportCount: number;
  /** Newest first, at most `reportsPerCase`. */
  reports: ContentReport[];
}

/**
 * The case rows and their reports are read in one repeatable-read snapshot. Read separately, a report committed
 * between the two would be shown and counted under a case row from before it, say without the CSAM category that
 * report gave the case, so the queue would not put it first.
 */
const CONSISTENT_READ = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

/** The review queue: CSAM first, then the most recently reported. */
export async function listReportedCases(options: { limit?: number; offset?: number; reportsPerCase?: number } = {}): Promise<ReportedCase[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const perCase = Math.min(Math.max(options.reportsPerCase ?? 20, 1), 100);
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(contentCases)
      .where(eq(contentCases.status, 'reported'))
      .orderBy(desc(sql`coalesce(${contentCases.category} = 'csam', false)`), desc(contentCases.updatedAt))
      .limit(limit)
      .offset(Math.max(options.offset ?? 0, 0));
    return attachReports(rows, perCase, tx);
  }, CONSISTENT_READ);
}

/** One case, in any status, with its first page of reports — for the case an alert links to. Null if there is none. */
export async function getReportedCase(caseId: string, perCase = 20): Promise<ReportedCase | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(contentCases).where(eq(contentCases.id, caseId)).limit(1);
    if (!row) return null;
    const [withReports] = await attachReports([row], perCase, tx);
    return withReports;
  }, CONSISTENT_READ);
}

/**
 * Reports for cases already loaded — for one case linked from an alert, or the review queue.
 *
 * The reports shown and the count are read in ONE statement (window functions over one snapshot). The admin closes a
 * case by sending back the count it was shown; read in two statements, a report committed between them would be
 * counted without being shown, and the close would acknowledge it unseen.
 */
export async function attachReports(rows: ContentCase[], perCase = 20, executor: Executor = db): Promise<ReportedCase[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const ranked = executor
    .select({
      ...getTableColumns(contentReports),
      rank: sql<number>`row_number() over (partition by ${contentReports.caseId} order by ${contentReports.createdAt} desc, ${contentReports.id} desc)`.as('rank'),
      total: sql<number>`count(*) over (partition by ${contentReports.caseId})`.mapWith(Number).as('total'),
    })
    .from(contentReports)
    .where(inArray(contentReports.caseId, ids))
    .as('ranked');
  const shown = await executor
    .select()
    .from(ranked)
    .where(lte(ranked.rank, perCase))
    .orderBy(desc(ranked.createdAt), desc(ranked.id));
  const byCase = new Map<string, ContentReport[]>();
  const totalByCase = new Map<string, number>();
  for (const { rank: _rank, total, ...report } of shown) {
    byCase.set(report.caseId, [...(byCase.get(report.caseId) ?? []), report]);
    totalByCase.set(report.caseId, Number(total));
  }
  return rows.map((row) => ({ case: row, reportCount: totalByCase.get(row.id) ?? 0, reports: byCase.get(row.id) ?? [] }));
}

/**
 * The case's reports older than `beforeId` (the last report already shown), newest first in the same order as
 * `attachReports`. Keyed on that report rather than an offset, so reports filed while an admin pages through shift
 * nothing: no page repeats or skips one. A `beforeId` that is not a report on this case pages nothing.
 */
export async function listCaseReports(caseId: string, options: { beforeId: string; limit?: number }): Promise<ContentReport[]> {
  const cursor = db
    .select({ createdAt: contentReports.createdAt, id: contentReports.id })
    .from(contentReports)
    .where(and(eq(contentReports.id, options.beforeId), eq(contentReports.caseId, caseId)));
  return db
    .select()
    .from(contentReports)
    .where(and(eq(contentReports.caseId, caseId), sql`(${contentReports.createdAt}, ${contentReports.id}) < (${cursor})`))
    .orderBy(desc(contentReports.createdAt), desc(contentReports.id))
    .limit(Math.min(Math.max(options.limit ?? 20, 1), 100));
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
  /**
   * The publish-scan flag the admin saw (`snapshot.scan.flaggedAt`), or null for none. The close is refused if
   * the case's flag differs: a flag that joined after the admin looked must not be dismissed unseen.
   */
  expectedScanFlaggedAt?: string | null;
  note?: string;
}): Promise<ContentCase> {
  const review = { outcome: input.outcome, actorUserId: input.actorUserId, note: input.note, at: new Date().toISOString() };
  return db.transaction(async (tx) => {
    // The same row lock a report takes to attach, so a report lands either before the count check or on a new case.
    // A scan flag joins under the same lock (scan-store `openScanReviewCase`), so it lands before this check or on a new case.
    const [locked] = await tx
      .select({ id: contentCases.id, snapshot: contentCases.snapshot, contentHash: contentCases.contentHash })
      .from(contentCases)
      .where(and(eq(contentCases.id, input.caseId), eq(contentCases.status, 'reported')))
      .limit(1)
      .for('update');
    if (!locked) throw new ReportedCaseNotFoundError(input.caseId);
    const [{ total }] = await tx.select({ total: count() }).from(contentReports).where(eq(contentReports.caseId, input.caseId));
    if (Number(total) !== input.expectedReportCount) throw new ReportedCaseChangedError(input.caseId);
    const scan = locked.snapshot?.scan?.source === 'scan_flagged' ? locked.snapshot.scan : null;
    if ((scan?.flaggedAt ?? null) !== (input.expectedScanFlaggedAt ?? null)) throw new ReportedCaseChangedError(input.caseId);

    // Dismissing a flagged scan is a reviewed false positive: the hash is recorded clean in the same
    // transaction, so the gate stops holding it, and a dismissal never lands without it (or the reverse).
    if (scan && input.outcome === 'dismissed' && locked.contentHash) {
      const clean = {
        verdict: 'clean' as const,
        outcome: 'clean' as const,
        provider: ADMIN_REVIEW_PROVIDER,
        mode: null,
        scores: { reviewedBy: input.actorUserId, caseId: input.caseId },
        scannedAt: new Date(),
      };
      // Except over a hash match on a blocked hash: dismissing the classifier flag does not lift the block, and
      // the match stays the record until staff lift the block itself.
      await tx
        .insert(contentScans)
        .values({ contentHash: locked.contentHash, ...clean })
        .onConflictDoUpdate({
          target: contentScans.contentHash,
          set: clean,
          setWhere: or(
            sql`${contentScans.outcome} is distinct from 'hash_match'`,
            sql`not exists (select 1 from ${contentBlocks} where ${contentBlocks.contentHash} = ${contentScans.contentHash})`,
          ),
        });
    }
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
