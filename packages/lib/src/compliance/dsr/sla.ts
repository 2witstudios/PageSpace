/**
 * Pure SLA math for Data Subject Requests (GDPR Art 12(3)).
 *
 * No clock access: every function takes the relevant instant as an argument so
 * the logic is fully deterministic and exhaustively testable. The statutory
 * window is one month; we encode it as 30 days, the conservative reading.
 */

import type { DataSubjectRequestStatus } from '@pagespace/db/schema/data-subject-requests';

export const SLA_DAYS = 30;

/** Within this many days of the deadline an open request is flagged "due soon". */
export const SLA_DUE_SOON_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type SlaStatus =
  | 'met' // resolved within the window
  | 'breached' // resolved, but after the deadline
  | 'on_track' // open, comfortably before the deadline
  | 'due_soon' // open, within SLA_DUE_SOON_DAYS of the deadline
  | 'overdue' // open, past the deadline
  | 'not_applicable'; // cancelled — no statutory obligation to fulfil

/** Minimal shape needed to judge SLA compliance — a slice of the DSR row. */
export interface SlaTrackable {
  status: DataSubjectRequestStatus;
  slaDeadline: Date;
  completedAt: Date | null;
}

/**
 * The statutory deadline: receipt + `slaDays`. Returns a fresh Date; never
 * mutates the input.
 */
export function computeSlaDeadline(receivedAt: Date, slaDays: number = SLA_DAYS): Date {
  return new Date(receivedAt.getTime() + slaDays * MS_PER_DAY);
}

/**
 * Classify a request's standing against its deadline at instant `now`.
 * Resolved requests are judged on their completion time; open requests on how
 * close `now` is to the deadline.
 */
export function computeSlaStatus(req: SlaTrackable, now: Date): SlaStatus {
  if (req.status === 'cancelled') {
    return 'not_applicable';
  }

  if (req.status === 'completed') {
    const completedAt = req.completedAt ?? now;
    return completedAt.getTime() <= req.slaDeadline.getTime() ? 'met' : 'breached';
  }

  const msRemaining = req.slaDeadline.getTime() - now.getTime();
  if (msRemaining < 0) {
    return 'overdue';
  }
  if (msRemaining <= SLA_DUE_SOON_DAYS * MS_PER_DAY) {
    return 'due_soon';
  }
  return 'on_track';
}

export interface SlaComplianceSummary {
  total: number;
  met: number;
  breached: number;
  on_track: number;
  due_soon: number;
  overdue: number;
  not_applicable: number;
}

/** Aggregate a batch of requests into per-status counts for admin visibility. */
export function summarizeSlaCompliance(requests: SlaTrackable[], now: Date): SlaComplianceSummary {
  const summary: SlaComplianceSummary = {
    total: requests.length,
    met: 0,
    breached: 0,
    on_track: 0,
    due_soon: 0,
    overdue: 0,
    not_applicable: 0,
  };
  for (const req of requests) {
    summary[computeSlaStatus(req, now)] += 1;
  }
  return summary;
}
