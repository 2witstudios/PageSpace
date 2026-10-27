'use client';

import React, { memo } from 'react';
import { CalendarClock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WorkflowCard, type WorkflowData } from './WorkflowCard';

interface WorkflowListRendererProps {
  workflows: WorkflowData[];
  maxHeight?: number;
  className?: string;
}

/**
 * WorkflowListRenderer - Lists the cron workflows in a drive (list_workflows).
 */
export const WorkflowListRenderer: React.FC<WorkflowListRendererProps> = memo(
  function WorkflowListRenderer({ workflows, maxHeight = 360, className }) {
    return (
      <div className={cn('rounded-lg border bg-card overflow-hidden my-2 shadow-sm', className)}>
        <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Workflows</span>
          </div>
          <span className="text-xs text-muted-foreground">
            {workflows.length} {workflows.length === 1 ? 'workflow' : 'workflows'}
          </span>
        </div>

        <div className="bg-background overflow-auto divide-y divide-border" style={{ maxHeight: `${maxHeight}px` }}>
          {workflows.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">No workflows in this drive</div>
          ) : (
            workflows.map((w, i) => <WorkflowCard key={w.workflowId ?? i} workflow={w} flat />)
          )}
        </div>
      </div>
    );
  }
);
