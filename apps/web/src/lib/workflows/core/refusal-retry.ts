/**
 * Whether a scheduled run refused by the credit gate should be retried on the
 * next tick instead of being recorded. Only a transient refusal retries, and
 * only while its occurrence is at most REFUSAL_RETRY_WINDOW_MS old: past that
 * it is recorded as an error, so a refused head-of-queue trigger cannot starve
 * the cron's due-trigger batch forever. A run with no occurrence time (manual,
 * task-completion, webhook) has no tick that would pick it up, so it never
 * retries. Pure.
 */

import type { GateRefusalKind } from '@pagespace/lib/billing/classify-gate-refusal';

export const REFUSAL_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function shouldRetryRefusal(input: {
  kind: GateRefusalKind;
  occurrenceAt: Date | null;
  now: Date;
}): boolean {
  if (input.kind !== 'transient' || input.occurrenceAt === null) return false;
  return input.now.getTime() - input.occurrenceAt.getTime() <= REFUSAL_RETRY_WINDOW_MS;
}
