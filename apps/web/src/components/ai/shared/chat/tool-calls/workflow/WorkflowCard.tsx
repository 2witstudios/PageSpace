'use client';

import React, { memo } from 'react';
import { Clock, Play, Pause, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePageNavigation } from '@/hooks/usePageNavigation';

export interface WorkflowData {
  workflowId?: string;
  name?: string | null;
  schedule?: string | null;
  cronExpression?: string | null;
  timezone?: string | null;
  isEnabled?: boolean;
  nextRunAt?: string | null;
  /** Agent page the workflow runs; enables click-through to open the agent. */
  agentPageId?: string | null;
  driveId?: string | null;
}

interface WorkflowCardProps {
  workflow: WorkflowData;
  /** When true, renders as a flat row (used inside the list). */
  flat?: boolean;
  className?: string;
}

const formatNextRun = (iso?: string | null, timezone?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  }
};

/**
 * WorkflowCard - Schedule summary for a single cron workflow.
 *
 * Shared between WorkflowListRenderer (flat rows) and the create/update result
 * renderers (single card).
 */
export const WorkflowCard: React.FC<WorkflowCardProps> = memo(function WorkflowCard({
  workflow,
  flat = false,
  className,
}) {
  const { navigateToPage } = usePageNavigation();
  const enabled = workflow.isEnabled !== false;
  const nextRun = formatNextRun(workflow.nextRunAt, workflow.timezone);
  const agentPageId = workflow.agentPageId ?? undefined;
  const canOpenAgent = Boolean(agentPageId);

  return (
    <div
      role={canOpenAgent ? 'button' : undefined}
      tabIndex={canOpenAgent ? 0 : undefined}
      onClick={canOpenAgent ? () => navigateToPage(agentPageId!, workflow.driveId ?? undefined) : undefined}
      onKeyDown={
        canOpenAgent
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigateToPage(agentPageId!, workflow.driveId ?? undefined);
              }
            }
          : undefined
      }
      className={cn(
        'flex items-start gap-3 px-3 py-2.5',
        !flat && 'rounded-lg border bg-card my-2 shadow-sm',
        canOpenAgent && 'cursor-pointer hover:bg-muted/50 transition-colors group',
        className
      )}
    >
      <div
        className={cn(
          'flex items-center justify-center w-8 h-8 rounded-md shrink-0',
          enabled ? 'bg-primary/10' : 'bg-muted'
        )}
      >
        {enabled ? (
          <Play className="h-4 w-4 text-primary" />
        ) : (
          <Pause className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{workflow.name || 'Workflow'}</span>
          <span
            className={cn(
              'text-xs px-1.5 py-0.5 rounded shrink-0',
              enabled
                ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                : 'bg-muted text-muted-foreground'
            )}
          >
            {enabled ? 'Active' : 'Paused'}
          </span>
          {canOpenAgent && (
            <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <Bot className="h-3 w-3" />
              Open agent
            </span>
          )}
        </div>

        <div className="text-xs text-muted-foreground mt-0.5">
          {workflow.schedule || workflow.cronExpression || 'No schedule'}
          {workflow.timezone && <span className="ml-1">({workflow.timezone})</span>}
        </div>

        {workflow.cronExpression && workflow.schedule && (
          <code className="text-[11px] text-muted-foreground/80 font-mono">{workflow.cronExpression}</code>
        )}

        {nextRun && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
            <Clock className="h-3 w-3 shrink-0" />
            Next run {nextRun}
          </div>
        )}
      </div>
    </div>
  );
});
