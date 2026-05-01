'use client';

import { useMemo, useState } from 'react';
import { Plus, Workflow as WorkflowIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { post, patch } from '@/lib/auth/auth-fetch';
import { useWorkflows } from '@/hooks/useWorkflows';
import { WorkflowList } from '@/components/workflows/WorkflowList';
import { WorkflowForm, type WorkflowFormData } from '@/components/workflows/WorkflowForm';
import { DeleteWorkflowDialog } from '@/components/workflows/DeleteWorkflowDialog';
import type { Workflow } from '@/components/workflows/types';

interface TaskListWorkflowsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driveId: string;
  pageId: string;
  taskListTitle: string;
}

export function TaskListWorkflowsDialog({
  open,
  onOpenChange,
  driveId,
  pageId,
  taskListTitle,
}: TaskListWorkflowsDialogProps) {
  const { workflows, isLoading, mutate, runWorkflow, toggleWorkflow, deleteWorkflow } = useWorkflows(open ? driveId : '');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);

  const scoped = useMemo(
    () => workflows.filter((wf) => Array.isArray(wf.contextPageIds) && wf.contextPageIds.includes(pageId)),
    [workflows, pageId],
  );

  const ensurePageAnchor = (ids: string[] | undefined): string[] => {
    const base = ids ?? [];
    return base.includes(pageId) ? base : [...base, pageId];
  };

  const handleCreate = async (data: WorkflowFormData) => {
    await post('/api/workflows', {
      ...data,
      contextPageIds: ensurePageAnchor(data.contextPageIds),
      driveId,
    });
    mutate();
    toast.success('Workflow created');
  };

  const handleUpdate = async (data: WorkflowFormData) => {
    if (!editing) return;
    await patch(`/api/workflows/${editing.id}`, {
      ...data,
      contextPageIds: ensurePageAnchor(data.contextPageIds),
    });
    mutate();
    toast.success('Workflow updated');
  };

  const handleRun = async (id: string) => {
    try {
      const result = await runWorkflow(id);
      if (result.success) toast.success('Workflow executed');
      else toast.error(result.error || 'Workflow execution failed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run workflow');
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await toggleWorkflow(id, enabled);
      toast.success(enabled ? 'Workflow enabled' : 'Workflow disabled');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update workflow');
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      await deleteWorkflow(deleteTarget.id);
      toast.success('Workflow deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete workflow');
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <WorkflowIcon className="h-4 w-4 text-muted-foreground" />
              Scheduled workflows
            </DialogTitle>
            <DialogDescription className="truncate">
              Recurring agents anchored to <span className="font-medium">{taskListTitle}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {scoped.length} workflow{scoped.length === 1 ? '' : 's'} on this task list
              </p>
              <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
                <Plus className="h-4 w-4 mr-1.5" />
                New workflow
              </Button>
            </div>

            {isLoading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
            ) : scoped.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No scheduled workflows yet. Create one to run an agent on a recurring schedule with this task list as context.
              </div>
            ) : (
              <WorkflowList
                workflows={scoped}
                onRun={handleRun}
                onToggle={handleToggle}
                onEdit={(wf) => { setEditing(wf); setFormOpen(true); }}
                onDelete={(id) => {
                  const wf = scoped.find((w) => w.id === id);
                  if (wf) setDeleteTarget(wf);
                }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <WorkflowForm
        open={formOpen}
        onOpenChange={setFormOpen}
        driveId={driveId}
        anchorPageId={pageId}
        anchorPageTitle={taskListTitle}
        initialData={editing
          ? {
              id: editing.id,
              name: editing.name,
              agentPageId: editing.agentPageId,
              prompt: editing.prompt,
              contextPageIds: ensurePageAnchor(editing.contextPageIds),
              cronExpression: editing.cronExpression ?? '0 9 * * 1-5',
              timezone: editing.timezone,
              isEnabled: editing.isEnabled,
            }
          : { contextPageIds: [pageId] }}
        onSubmit={editing ? handleUpdate : handleCreate}
      />

      <DeleteWorkflowDialog
        workflowName={deleteTarget?.name ?? ''}
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}
