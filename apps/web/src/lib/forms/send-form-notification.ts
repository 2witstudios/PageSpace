import React from 'react';
import { sendEmail, resolveAppUrl } from '@pagespace/lib/services/email-service';
import {
  FormSubmissionNotificationEmail,
  type FormSubmissionEntry,
} from '@pagespace/lib/email-templates/FormSubmissionNotificationEmail';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { FormTarget, FormFieldDef } from '@pagespace/db/schema/form-targets';

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/**
 * Maps validated submission values to labeled entries for the email body,
 * using the form target's field definitions for human-readable labels.
 */
function buildEntries(
  fields: FormFieldDef[],
  values: Record<string, string | boolean>,
): FormSubmissionEntry[] {
  return fields.map((field) => {
    const raw = values[field.name];
    const value = typeof raw === 'boolean' ? (raw ? 'Yes' : 'No') : (raw ?? '');
    return { label: field.label, value };
  });
}

/**
 * Best-effort notification email on a form submission. Never throws —
 * a Resend failure must not affect the submission that already succeeded
 * (the row is already appended) or force the public route to return an error.
 *
 * Skips sendEmail's default 3/hr-per-recipient rate limit: the caller (the
 * submit route) already applies a per-form-target cap on this dispatch, and
 * a busy legitimate form can exceed 3 submissions/hr on its own.
 */
export async function sendFormSubmissionNotification(params: {
  formTarget: FormTarget;
  values: Record<string, string | boolean>;
  submittedAt: Date;
}): Promise<void> {
  const { formTarget, values, submittedAt } = params;

  try {
    await sendEmail({
      to: formTarget.notificationEmail!,
      subject: 'New form submission',
      react: React.createElement(FormSubmissionNotificationEmail, {
        entries: buildEntries(formTarget.fields, values),
        submittedAt: formatTimestamp(submittedAt),
        sheetUrl: `${resolveAppUrl()}/dashboard/${formTarget.driveId}/${formTarget.pageId}`,
      }),
      skipRateLimit: true,
    });
  } catch (error) {
    // Catches both a rejected send and a synchronous throw while building the
    // email (e.g. resolveAppUrl() on a misconfigured WEB_APP_URL) — either
    // way this must resolve, never reject, with the formTargetId preserved
    // for triage.
    loggers.api.error(
      'Failed to send form submission notification',
      error instanceof Error ? error : undefined,
      { formTargetId: formTarget.id },
    );
  }
}
