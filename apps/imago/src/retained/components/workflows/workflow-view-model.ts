import { getHumanReadableCron } from '@/retained/lib/workflows/cron-utils';
import type { Workflow, WorkflowLastRun } from './types';
import type { WorkflowStep } from './WorkflowStepsEditor';

/** The colour family a last-run badge reads in. */
export type LastRunTone = 'success' | 'danger' | 'running' | 'neutral';

const LAST_RUN_LABELS: Readonly<Record<WorkflowLastRun['status'], string>> = {
  success: 'Success',
  error: 'Error',
  running: 'Running',
  cancelled: 'Cancelled',
};

/** The badge text for a workflow's latest run; a workflow that never ran says so. */
export const lastRunLabel = (lastRun: WorkflowLastRun | null): string =>
  lastRun === null ? 'Never run' : LAST_RUN_LABELS[lastRun.status];

export const lastRunTone = (lastRun: WorkflowLastRun | null): LastRunTone => {
  switch (lastRun?.status) {
    case 'success':
      return 'success';
    case 'error':
      return 'danger';
    case 'running':
      return 'running';
    default:
      return 'neutral';
  }
};

/** A cron expression in words, as the form previews it ("At 08:00 AM, Monday through Friday"). */
export const scheduleText = (cronExpression: string | null): string =>
  cronExpression === null ? '' : getHumanReadableCron(cronExpression);

/** "in 22 hours", "in 5 minutes", "in 3 days" from `now`; past instants read "just now". */
export const relativeRunText = (target: Date, now: Date): string => {
  const diffMinutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (Math.abs(diffMinutes) < 1) return 'just now';
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
  const absMinutes = Math.abs(diffMinutes);
  if (absMinutes < 60) return formatter.format(diffMinutes, 'minute');
  const hours = Math.round(diffMinutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(diffMinutes / (60 * 24)), 'day');
};

/** "Tue, Oct 13, 8:00 AM" for the next run's absolute time. */
export const nextRunDateText = (nextRunAt: Date): string =>
  nextRunAt.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export type StepView = {
  readonly n: number;
  readonly kind: 'Tool' | 'AI';
  readonly title: string;
  readonly detail: string;
};

/**
 * A workflow's steps as the detail lists them. Tool steps run without a model; AI steps name
 * their agent, falling back to the workflow's own agent when the step carries none.
 */
export const stepViews = (
  steps: readonly WorkflowStep[],
  agentTitles: ReadonlyMap<string, string>,
  fallbackAgentPageId: string | null,
): readonly StepView[] =>
  steps.map((step, index) => {
    if (step.kind === 'tool') {
      return { n: index + 1, kind: 'Tool', title: step.toolName, detail: JSON.stringify(step.args) };
    }
    const agentId = step.agentPageId ?? fallbackAgentPageId;
    const agentName = agentId === null ? undefined : agentTitles.get(agentId);
    return { n: index + 1, kind: 'AI', title: agentName ?? 'AI step', detail: step.prompt };
  });

/** The workflow's schedule, when it has one; a workflow without a cron expression has no schedule card. */
export const hasSchedule = (workflow: Pick<Workflow, 'cronExpression'>): boolean =>
  workflow.cronExpression !== null && workflow.cronExpression.trim() !== '';
