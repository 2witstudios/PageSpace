import { AgentBadge } from '@/components/shared/AgentBadge';
import type { TaskItem } from './task-list-types';

/**
 * The kanban card's assignee: the user's name (marked when it belongs to an AI
 * agent account, Agent Signup 2c) or the AI agent page's title.
 */
export function TaskAssigneeLabel({ task }: { task: Pick<TaskItem, 'assignee' | 'assigneeAgent'> }) {
  if (!task.assignee && !task.assigneeAgent) return null;
  return (
    <>
      <span className="text-xs text-muted-foreground">
        {task.assignee?.name || task.assigneeAgent?.title || 'Assigned'}
      </span>
      {task.assignee?.name && <AgentBadge accountType={task.assignee.accountType} />}
    </>
  );
}
