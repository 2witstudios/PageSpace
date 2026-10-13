import type { ReactNode } from 'react';
import { Icon } from '../../components/icon/icon';
import type { AutomationRow } from './task-automations';
import {
  taskAutomationRowClass,
  taskAutomationTextClass,
  taskAutomationWhenClass,
  taskAutomationsClass,
  taskSectionHeadingClass,
  taskSwitchClass,
  taskSwitchKnobClass,
} from './task-detail-class';

export type TaskAutomationsRenderProps = {
  readonly rows: readonly AutomationRow[];
  /** Opens the trigger dialog, where a trigger is edited. */
  readonly open: () => void;
};

const subject = (row: AutomationRow): string => (row.agent === null ? 'run' : `run with ${row.agent}`);

/**
 * The task's triggers: a due trigger as "When due → run …", the completion
 * trigger (or its empty placeholder) as "On completion → …". Each opens the
 * trigger dialog to edit it.
 */
export function renderTaskAutomations({ rows, open }: TaskAutomationsRenderProps): ReactNode {
  const hasCompletion = rows.some((row) => row.kind === 'completion');
  return (
    <section aria-label="Automations" className="flex flex-col gap-2">
      <h3 className={taskSectionHeadingClass}>Automations</h3>
      <div className={taskAutomationsClass}>
        {rows.map((row) => (
          <div key={row.id} className={taskAutomationRowClass}>
            <Icon name="workflows" size={15} />
            <button type="button" className={taskAutomationTextClass} onClick={open}>
              {row.kind === 'due_date' ? `When due → ${subject(row)}` : `On completion → ${subject(row)}`}
            </button>
            {row.nextRun === null ? null : <span className={taskAutomationWhenClass}>{row.nextRun}</span>}
            <span role="switch" aria-checked={row.enabled} aria-label="Enabled" aria-disabled="true" className={taskSwitchClass}>
              <span className={taskSwitchKnobClass} />
            </span>
          </div>
        ))}
        {hasCompletion ? null : (
          <div className={taskAutomationRowClass}>
            <Icon name="plus" size={15} />
            <button type="button" className={taskAutomationTextClass} onClick={open}>
              On completion → run a workflow…
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
