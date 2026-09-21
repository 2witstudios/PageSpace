/**
 * Whether a workflow run that could not start (a transient credit refusal, or
 * the gate itself failing) should be left for the next tick instead of being
 * recorded. Only runs a scheduler re-discovers can retry — calendar
 * occurrences, task triggers (due-date and completion, both driven by the
 * task-triggers cron) and cron workflows — and only while the occurrence is at
 * most REFUSAL_RETRY_WINDOW_MS old: past that it is recorded as an error, so a
 * refused head-of-queue trigger cannot starve the cron's due batch forever.
 * Webhook and manual fires are never re-fired by anything, so they never
 * retry, whatever their timestamp. Pure.
 */

import type { GateRefusalKind } from '@pagespace/lib/billing/classify-gate-refusal';

export const REFUSAL_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

const RESCHEDULED_SOURCES: ReadonlySet<string> = new Set(['calendarTriggers', 'taskTriggers', 'cron']);

export function shouldRetryRefusal(input: {
  kind: GateRefusalKind;
  source: { table: string; triggerAt: Date | null };
  now: Date;
}): boolean {
  const { kind, source, now } = input;
  if (kind !== 'transient' || !RESCHEDULED_SOURCES.has(source.table) || source.triggerAt === null) return false;
  return now.getTime() - source.triggerAt.getTime() <= REFUSAL_RETRY_WINDOW_MS;
}
