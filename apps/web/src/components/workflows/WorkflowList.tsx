'use client';

import { useState } from 'react';
import { Play, Pencil, Trash2, Loader2, Clock, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { WorkflowStatusBadge } from './WorkflowStatusBadge';
import type { Workflow } from './types';

interface WorkflowListProps {
  workflows: Workflow[];
  onRun: (id: string) => Promise<void> | void;
  onToggle: (id: string, enabled: boolean) => Promise<void> | void;
  onEdit: (workflow: Workflow) => void;
  onDelete: (id: string) => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WorkflowList({ workflows, onRun, onToggle, onEdit, onDelete }: WorkflowListProps) {
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  const handleRun = async (id: string) => {
    setRunningIds(prev => new Set(prev).add(id));
    try {
      await onRun(id);
    } finally {
      setRunningIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (workflows.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p>No workflows yet. Create one to get started.</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Schedule</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last Run</TableHead>
            <TableHead>Next Run</TableHead>
            <TableHead className="text-center">Enabled</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workflows.map(workflow => (
            <TableRow key={workflow.id}>
              <TableCell className="font-medium">{workflow.name}</TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {workflow.triggerType === 'event' ? (
                  <div className="flex items-center gap-1.5">
                    <Zap className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
                    <span className="text-xs">
                      {(workflow.eventTriggers ?? []).map(t => `${t.operation}:${t.resourceType}`).join(', ') || 'Event'}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="font-mono">{workflow.cronExpression}</span>
                  </div>
                )}
              </TableCell>
              <TableCell>
                <Tooltip>
                  <TooltipTrigger>
                    <WorkflowStatusBadge status={workflow.lastRunStatus} />
                  </TooltipTrigger>
                  {workflow.lastRunError && (
                    <TooltipContent className="max-w-xs">
                      <p className="text-xs">{workflow.lastRunError}</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDate(workflow.lastRunAt)}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDate(workflow.nextRunAt)}
              </TableCell>
              <TableCell className="text-center">
                <Switch
                  checked={workflow.isEnabled}
                  onCheckedChange={(checked) => onToggle(workflow.id, checked)}
                />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRun(workflow.id)}
                    disabled={runningIds.has(workflow.id)}
                    className="h-8 w-8 p-0"
                    aria-label="Run workflow"
                  >
                    {runningIds.has(workflow.id) ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEdit(workflow)}
                    className="h-8 w-8 p-0"
                    aria-label="Edit workflow"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(workflow.id)}
                    className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    aria-label="Delete workflow"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
