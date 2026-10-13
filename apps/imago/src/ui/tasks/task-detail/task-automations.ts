// The Automations section's rows, from GET /api/tasks/[taskId]/triggers.
// Pure: the agents on the drive decide which name a trigger runs with.

import type { Assignee, TaskTriggerResponse } from '../task-model/task';

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export type AutomationRow = {
  readonly id: string;
  readonly kind: 'due_date' | 'completion';
  readonly enabled: boolean;
  /** The agent the trigger runs with, when the drive's agents name it. */
  readonly agent: string | null;
  /** When a due trigger next runs, formatted; null for completion or unscheduled. */
  readonly nextRun: string | null;
};

/** A trigger's row. The workflow's own name is not in the API yet, so it is not shown. */
export const automationRow = (trigger: TaskTriggerResponse, agents: readonly Assignee[]): AutomationRow => ({
  id: trigger.id,
  kind: trigger.triggerType,
  enabled: trigger.isEnabled,
  agent: agents.find((entry) => entry.type === 'agent' && entry.id === trigger.agentPageId)?.name ?? null,
  nextRun:
    trigger.triggerType === 'due_date' && trigger.nextRunAt !== null
      ? dateFormat.format(new Date(trigger.nextRunAt))
      : null,
});

/** The rows to draw: the due trigger when there is one, then the completion trigger or its empty placeholder. */
export const automationRows = (
  triggers: readonly TaskTriggerResponse[],
  agents: readonly Assignee[],
): readonly AutomationRow[] => {
  const due = triggers.find((trigger) => trigger.triggerType === 'due_date');
  const completion = triggers.find((trigger) => trigger.triggerType === 'completion');
  return [
    ...(due === undefined ? [] : [automationRow(due, agents)]),
    ...(completion === undefined ? [] : [automationRow(completion, agents)]),
  ];
};
