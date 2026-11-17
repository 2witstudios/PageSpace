import type { ContentReport } from '@pagespace/db/schema/content-safety';
import type { ReportedCase } from '@pagespace/lib/content-safety/report-store';
import { toCaseSummary, type CaseSummary } from './case-summary';

/**
 * One report as the review queue shows it. The reporter is a user ID or
 * "anonymous" — there is no IP to show, none is stored. `description` is the
 * reporter's own words: the console renders it as inert text, never as markup
 * or a link.
 */
export interface ReportSummary {
  id: string;
  category: ContentReport['category'];
  source: ContentReport['source'];
  reporterUserId: string | null;
  contactEmail: string | null;
  description: string | null;
  createdAt: string;
}

export interface ReportedCaseSummary {
  case: CaseSummary;
  reportCount: number;
  /** Newest first; may be fewer than `reportCount`. */
  reports: ReportSummary[];
}

export function toReportSummary(report: ContentReport): ReportSummary {
  return {
    id: report.id,
    category: report.category,
    source: report.source,
    reporterUserId: report.reporterUserId,
    contactEmail: report.contactEmail,
    description: report.description,
    createdAt: report.createdAt.toISOString(),
  };
}

export function toReportedCaseSummary(row: ReportedCase): ReportedCaseSummary {
  return { case: toCaseSummary(row.case), reportCount: row.reportCount, reports: row.reports.map(toReportSummary) };
}

/**
 * Append a later page of a case's reports. Pages are newest first by offset, so a report filed since the last page
 * shifts every offset by one and the next page repeats a report already shown; it is dropped, never shown twice.
 */
export function mergeReportPages(shown: ReportSummary[], page: ReportSummary[]): ReportSummary[] {
  const seen = new Set(shown.map((report) => report.id));
  return [...shown, ...page.filter((report) => !seen.has(report.id))];
}
