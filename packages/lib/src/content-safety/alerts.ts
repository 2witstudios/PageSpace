/**
 * Alerts to the abuse inbox when a case opens, is actioned, stops at the
 * evidence step, or has a re-sweep fail — for every report, whether it
 * opened a case or joined one under review — and when the publish scan flags a file.
 *
 * The email carries a case ID, a category, a report count and an admin link —
 * never a file URL, filename, hash, reported URL, the reporter's words or any
 * content (see ContentSafetyAlertEmail). A CSAM report is marked urgent in the
 * subject and sent as high priority. On-prem deployments
 * send no email at all (`sendEmail` is a no-op there), so the alert is also
 * logged; the case row remains the record in every mode.
 */

import * as React from 'react';
import { ContentSafetyAlertEmail, contentSafetyAlertSubject } from '../email-templates/ContentSafetyAlertEmail';
import { loggers } from '../logging/logger-config';
import { sendEmail } from '../services/email-service';
import type { ReportAlert } from './report-intake';
import type { ScanAlert } from './publish-gate';
import type { TakedownAlert } from './takedown';

export type ContentSafetyAlert = TakedownAlert | ReportAlert | ScanAlert;

const isReportAlert = (alert: ContentSafetyAlert): alert is ReportAlert =>
  alert.event === 'report_opened' || alert.event === 'report_added';

/** Headers mail clients read as "high priority". Only for CSAM reports, which are acted on immediately. */
const URGENT_HEADERS = { 'X-Priority': '1', Importance: 'high', Priority: 'urgent' } as const;

const FALLBACK_ABUSE_EMAIL = 'hello@pagespace.ai';

type Env = Record<string, string | undefined>;

/** `ABUSE_EMAIL`, then `CONTACT_EMAIL`, then the public contact address. */
export function resolveAbuseEmail(env: Env = process.env): string {
  return env.ABUSE_EMAIL?.trim() || env.CONTACT_EMAIL?.trim() || FALLBACK_ABUSE_EMAIL;
}

/** `value` with every trailing `/` removed, in one pass (an anchored `/\/+$/` backtracks quadratically). */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/** The case's page in the admin console, or undefined when no admin URL is configured. */
export function contentCaseAdminUrl(caseId: string, env: Env = process.env): string | undefined {
  const base = withoutTrailingSlashes((env.ADMIN_APP_URL || env.NEXT_PUBLIC_ADMIN_APP_URL)?.trim() ?? '');
  return base ? `${base}/content?case=${encodeURIComponent(caseId)}` : undefined;
}

/** Send the alert. Throws on failure; takedown callers go through `TakedownDeps.alert`, which swallows it. */
export async function sendContentSafetyAlert(alert: ContentSafetyAlert): Promise<void> {
  const category = alert.category ?? 'uncategorised';
  const reportCount = isReportAlert(alert) ? alert.reportCount : undefined;
  // A CSAM report, and suspected CSAM found by the publish scan (live on the web in shadow mode), are urgent.
  const urgent = (isReportAlert(alert) && alert.category === 'csam') || alert.event === 'scan_flagged';
  loggers.security.warn('Content safety case alert', { event: alert.event, caseId: alert.caseId, category, reportCount });

  // Each report is its own alert: the count keeps a later report from collapsing into the first.
  const idempotencyKey = isReportAlert(alert)
    ? `content-case:${alert.caseId}:report:${alert.reportCount}`
    : `content-case:${alert.caseId}:${alert.event}${'attempt' in alert && alert.attempt ? `:${alert.attempt}` : ''}`;

  try {
    await sendEmail({
      to: resolveAbuseEmail(),
      subject: contentSafetyAlertSubject({ event: alert.event, caseId: alert.caseId, urgent }),
      react: React.createElement(ContentSafetyAlertEmail, {
        event: alert.event,
        caseId: alert.caseId,
        category,
        reportCount,
        adminUrl: contentCaseAdminUrl(alert.caseId),
      }),
      ...(urgent ? { headers: { ...URGENT_HEADERS } } : {}),
      // An abuse alert must not be dropped by the per-recipient cap shared with every other email.
      skipRateLimit: true,
      // The attempt (or report count) keeps each alert distinct; without it a retry's alert would collapse into the first.
      idempotencyKey,
    });
  } catch (error) {
    loggers.security.error('Content safety alert email failed', error instanceof Error ? error : undefined, {
      event: alert.event,
      caseId: alert.caseId,
    });
    throw error;
  }
}
