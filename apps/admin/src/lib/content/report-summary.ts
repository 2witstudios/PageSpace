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

export function toReportedCaseSummary(row: ReportedCase): ReportedCaseSummary {
  return {
    case: toCaseSummary(row.case),
    reportCount: row.reportCount,
    reports: row.reports.map((report) => ({
      id: report.id,
      category: report.category,
      source: report.source,
      reporterUserId: report.reporterUserId,
      contactEmail: report.contactEmail,
      description: report.description,
      createdAt: report.createdAt.toISOString(),
    })),
  };
}
