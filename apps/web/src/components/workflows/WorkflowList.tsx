'use client';

import { useState } from 'react';
import { Play, Pencil, Trash2, Loader2, Clock } from 'lucide-react';
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
import { automationRunState } from '@pagespace/lib/billing/automation-run-record';
import { AutomationSkippedBadge, AutomationSpendLine, type AutomationSpendContext } from '@/components/wallets/AutomationSpendState';
import { WorkflowStatusBadge } from './WorkflowStatusBadge';
import type { Workflow } from './types';

/** [D-OW-36] `ownerLeftAt` arrives with the owner-left contract; read defensively until then. */
type ListedWorkflow = Workflow & { ownerLeftAt?: string | null };

interface WorkflowListProps {
  workflows: ListedWorkflow[];
  /** Where these automations spend (orgs on): each row says whom it spends as and why a run was skipped. */
  spendContext?: AutomationSpendContext;
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

export function WorkflowList({ workflows, spendContext, onRun, onToggle, onEdit, onDelete }: WorkflowListProps) {
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
            {/* On a phone the name, status, switch and Run stay in view; times wait for wider screens. */}
            <TableHead className="hidden md:table-cell">Schedule</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Last Run</TableHead>
            <TableHead className="hidden md:table-cell">Next Run</TableHead>
            <TableHead className="text-center">Enabled</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workflows.map(workflow => {
            const runState = spendContext
              ? automationRunState({ ownerLeftAt: workflow.ownerLeftAt, lastRunStatus: workflow.lastRun?.status ?? null, lastRunError: workflow.lastRun?.error ?? null })
              : { kind: 'normal' as const };
            const creatorName = workflow.createdBy ? spendContext?.creatorNames[workflow.createdBy] ?? null : null;
            const status = runState.kind === 'skipped' && spendContext ? (
              <AutomationSkippedBadge state={runState} creatorName={creatorName} context={spendContext} />
            ) : (
              <Tooltip>
                <TooltipTrigger>
                  <WorkflowStatusBadge status={workflow.lastRun?.status ?? 'never_run'} />
                </TooltipTrigger>
                {workflow.lastRun?.error && (
                  <TooltipContent className="max-w-xs">
                    <p className="text-xs">{workflow.lastRun.error}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            );
            return (
            <TableRow key={workflow.id}>
              <TableCell className="font-medium">
                <div className="flex flex-col">
                  <span>{workflow.name}</span>
                  {spendContext && (
                    <AutomationSpendLine creatorName={creatorName} walletLabel={spendContext.walletLabel} ownerLeft={runState.kind === 'owner_left'} />
                  )}
                </div>
              </TableCell>
              <TableCell className="hidden text-muted-foreground text-sm md:table-cell">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="font-mono">{workflow.cronExpression ?? '-'}</span>
                </div>
              </TableCell>
              <TableCell>{status}</TableCell>
              <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                {formatDate(workflow.lastRun?.startedAt ?? null)}
              </TableCell>
              <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                {formatDate(workflow.nextRunAt)}
              </TableCell>
              <TableCell className="text-center">
                <Switch
                  checked={workflow.isEnabled && runState.kind !== 'owner_left'}
                  disabled={runState.kind === 'owner_left'}
                  onCheckedChange={(checked) => onToggle(workflow.id, checked)}
                />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRun(workflow.id)}
                    // [D-OW-36] nothing runs under a missing person, by schedule or by hand.
                    disabled={runningIds.has(workflow.id) || runState.kind === 'owner_left'}
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
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
