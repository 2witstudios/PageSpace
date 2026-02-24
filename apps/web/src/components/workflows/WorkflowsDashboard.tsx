'use client';

import { useState } from 'react';
import { Plus, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { post, patch } from '@/lib/auth/auth-fetch';
import { useWorkflows } from '@/hooks/useWorkflows';
import { WorkflowList } from './WorkflowList';
import { WorkflowForm } from './WorkflowForm';
import { DeleteWorkflowDialog } from './DeleteWorkflowDialog';
import type { Workflow } from './types';

interface WorkflowsDashboardProps {
  driveId: string;
  driveName: string;
}

export function WorkflowsDashboard({ driveId, driveName }: WorkflowsDashboardProps) {
  const { workflows, isLoading, mutate, runWorkflow, toggleWorkflow, deleteWorkflow } = useWorkflows(driveId);
  const [formOpen, setFormOpen] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);

  const handleCreate = async (data: {
    name: string;
    agentPageId: string;
    prompt: string;
    contextPageIds: string[];
    triggerType: 'cron' | 'event';
    cronExpression?: string;
    timezone: string;
    isEnabled: boolean;
    eventTriggers?: { operation: string; resourceType: string }[];
    watchedFolderIds?: string[];
    eventDebounceSecs?: number;
  }) => {
    await post('/api/workflows', { ...data, driveId });
    mutate();
    toast.success('Workflow created');
  };

  const handleUpdate = async (data: {
    name: string;
    agentPageId: string;
    prompt: string;
    contextPageIds: string[];
    triggerType: 'cron' | 'event';
    cronExpression?: string;
    timezone: string;
    isEnabled: boolean;
    eventTriggers?: { operation: string; resourceType: string }[];
    watchedFolderIds?: string[];
    eventDebounceSecs?: number;
  }) => {
    if (!editingWorkflow) return;
    await patch(`/api/workflows/${editingWorkflow.id}`, data);
    mutate();
    toast.success('Workflow updated');
  };

  const handleRun = async (id: string) => {
    try {
      const result = await runWorkflow(id);
      if (result.success) {
        toast.success('Workflow executed successfully');
      } else {
        toast.error(result.error || 'Workflow execution failed');
      }
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

  const handleDeleteClick = (id: string) => {
    const workflow = workflows.find(w => w.id === id);
    if (workflow) setDeleteTarget(workflow);
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

  const handleEdit = (workflow: Workflow) => {
    setEditingWorkflow(workflow);
    setFormOpen(true);
  };

  const handleOpenCreate = () => {
    setEditingWorkflow(null);
    setFormOpen(true);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-5xl">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-6 w-6 text-muted-foreground" />
              <h1 className="text-2xl font-bold">Workflows</h1>
              <span className="text-muted-foreground">- {driveName}</span>
            </div>
            <Button onClick={handleOpenCreate}>
              <Plus className="h-4 w-4 mr-1.5" />
              Create Workflow
            </Button>
          </div>

          <p className="text-muted-foreground text-sm">
            Automate AI agents with scheduled cron jobs or event triggers. Each workflow executes an agent with a prompt — on a schedule or when something happens in your drive.
          </p>

          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">Loading workflows...</div>
          ) : (
            <WorkflowList
              workflows={workflows}
              onRun={handleRun}
              onToggle={handleToggle}
              onEdit={handleEdit}
              onDelete={handleDeleteClick}
            />
          )}
        </div>
      </div>

      <WorkflowForm
        open={formOpen}
        onOpenChange={setFormOpen}
        driveId={driveId}
        initialData={editingWorkflow ? {
          id: editingWorkflow.id,
          name: editingWorkflow.name,
          agentPageId: editingWorkflow.agentPageId,
          prompt: editingWorkflow.prompt,
          contextPageIds: editingWorkflow.contextPageIds ?? [],
          triggerType: editingWorkflow.triggerType ?? 'cron',
          cronExpression: editingWorkflow.cronExpression ?? undefined,
          timezone: editingWorkflow.timezone,
          isEnabled: editingWorkflow.isEnabled,
          eventTriggers: editingWorkflow.eventTriggers ?? undefined,
          watchedFolderIds: editingWorkflow.watchedFolderIds ?? undefined,
          eventDebounceSecs: editingWorkflow.eventDebounceSecs ?? undefined,
        } : undefined}
        onSubmit={editingWorkflow ? handleUpdate : handleCreate}
      />

      <DeleteWorkflowDialog
        workflowName={deleteTarget?.name ?? ''}
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}
