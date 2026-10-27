/**
 * Pure state machine for Data Subject Request lifecycle.
 *
 * Encodes the legal transitions so neither the queue worker nor the admin
 * routes can drive a request into an illegal state (e.g. resurrecting a
 * completed erasure). No I/O — just the transition table.
 */

import type { DataSubjectRequestStatus } from '@pagespace/db/schema/data-subject-requests';

export const DSR_STATUSES = [
  'pending',
  'queued',
  'in_progress',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly DataSubjectRequestStatus[];

const TERMINAL: ReadonlySet<DataSubjectRequestStatus> = new Set(['completed', 'cancelled', 'failed']);

/** Allowed forward edges keyed by source state. */
const TRANSITIONS: Record<DataSubjectRequestStatus, readonly DataSubjectRequestStatus[]> = {
  pending: ['queued', 'in_progress', 'cancelled'],
  queued: ['in_progress', 'blocked', 'failed', 'cancelled'],
  in_progress: ['completed', 'blocked', 'failed'],
  blocked: ['queued', 'in_progress', 'cancelled'],
  // `failed` is retryable — re-queue for another attempt.
  failed: ['queued'],
  completed: [],
  cancelled: [],
};

export function isTerminalStatus(status: DataSubjectRequestStatus): boolean {
  return TERMINAL.has(status);
}

export function canTransition(
  from: DataSubjectRequestStatus,
  to: DataSubjectRequestStatus
): boolean {
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}
