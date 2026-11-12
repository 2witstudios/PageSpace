/**
 * Alerts to the abuse inbox when a case opens, is actioned, stops at the
 * evidence step, or has a re-sweep fail.
 *
 * The email carries a case ID, a category and an admin link — never a file URL,
 * filename, hash or content (see ContentSafetyAlertEmail). On-prem deployments
 * send no email at all (`sendEmail` is a no-op there), so the alert is also
 * logged; the case row remains the record in every mode.
 */

import * as React from 'react';
import { ContentSafetyAlertEmail, contentSafetyAlertSubject } from '../email-templates/ContentSafetyAlertEmail';
import { loggers } from '../logging/logger-config';
import { sendEmail } from '../services/email-service';
import type { TakedownAlert } from './takedown';

const FALLBACK_ABUSE_EMAIL = 'hello@pagespace.ai';

type Env = Record<string, string | undefined>;

/** `ABUSE_EMAIL`, then `CONTACT_EMAIL`, then the public contact address. */
export function resolveAbuseEmail(env: Env = process.env): string {
  return env.ABUSE_EMAIL?.trim() || env.CONTACT_EMAIL?.trim() || FALLBACK_ABUSE_EMAIL;
}

/** The case's page in the admin console, or undefined when no admin URL is configured. */
export function contentCaseAdminUrl(caseId: string, env: Env = process.env): string | undefined {
  const base = (env.ADMIN_APP_URL || env.NEXT_PUBLIC_ADMIN_APP_URL)?.trim().replace(/\/+$/, '');
  return base ? `${base}/content?case=${encodeURIComponent(caseId)}` : undefined;
}

/** Send the alert. Throws on failure; takedown callers go through `TakedownDeps.alert`, which swallows it. */
export async function sendContentSafetyAlert(alert: TakedownAlert): Promise<void> {
  const category = alert.category ?? 'uncategorised';
  loggers.security.warn('Content safety case alert', { event: alert.event, caseId: alert.caseId, category });

  try {
    await sendEmail({
      to: resolveAbuseEmail(),
      subject: contentSafetyAlertSubject(alert),
      react: React.createElement(ContentSafetyAlertEmail, {
        event: alert.event,
        caseId: alert.caseId,
        category,
        adminUrl: contentCaseAdminUrl(alert.caseId),
      }),
      // An abuse alert must not be dropped by the per-recipient cap shared with every other email.
      skipRateLimit: true,
      // The attempt keeps each failed re-sweep's alert distinct; without it a retry's alert would collapse into the first.
      idempotencyKey: `content-case:${alert.caseId}:${alert.event}${alert.attempt ? `:${alert.attempt}` : ''}`,
    });
  } catch (error) {
    loggers.security.error('Content safety alert email failed', error instanceof Error ? error : undefined, {
      event: alert.event,
      caseId: alert.caseId,
    });
    throw error;
  }
}
