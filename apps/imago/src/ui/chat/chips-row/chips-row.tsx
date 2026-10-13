'use client';

import { AiUsageMonitor } from '@/retained/components/ai/shared/AiUsageMonitor';
import { PlanChip } from '@/retained/components/ai/shared/PlanChip';
import { TasksDropdown } from '@/retained/components/ai/shared/TasksDropdown';
import { useRenderedMessages } from '@/retained/hooks/useRenderedMessages';
import { RetainedSurface } from '@/retained-adapters/retained-provider';

/**
 * The 28px row above the spend strip (IMC-2.10): the conversation's plan, its
 * tasks and its context usage. Each retained chip renders nothing when it has
 * nothing to show, so the row collapses with `empty:hidden` rather than
 * showing an empty bar.
 */
export const chipsRowClass = 'mx-2 flex h-spend-strip flex-none items-center gap-2 px-1 text-xs text-ink-muted empty:hidden';

export type ChipsRowProps = {
  readonly conversationId: string | null;
  /** The agent page the conversation belongs to; keys its live stream. Null on the global route. */
  readonly agentId: string | null;
  /** The drive the tasks' assignee picker falls back to. */
  readonly driveId?: string;
};

export function ChipsRow({ conversationId, agentId, driveId }: ChipsRowProps) {
  // The same message cache the chat renders from, so the tasks follow the live turn.
  const messages = useRenderedMessages(agentId ?? '', conversationId).map((rendered) => rendered.message);
  return (
    <RetainedSurface fill={false}>
      <div className={chipsRowClass}>
        <PlanChip conversationId={conversationId} messages={messages} />
        <TasksDropdown messages={messages} driveId={driveId} />
        <AiUsageMonitor conversationId={conversationId} />
      </div>
    </RetainedSurface>
  );
}
