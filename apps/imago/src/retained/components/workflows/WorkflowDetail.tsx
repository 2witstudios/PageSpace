'use client';

import { useAutomationSpendContext } from '@/retained/hooks/useAutomationSpendContext';
import { AutomationSpendLine, type AutomationSpendContext } from '@/retained/components/wallets/AutomationSpendState';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Pencil, Play, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from '@/retained-adapters/navigation';
import { Badge } from '@/retained/components/ui/badge';
import { Button } from '@/retained/components/ui/button';
import { Switch } from '@/retained/components/ui/switch';
import { del, patch, post } from '@/retained/lib/auth/auth-fetch';
import { DeleteWorkflowDialog } from './DeleteWorkflowDialog';
import { WorkflowForm, type WorkflowFormData } from './WorkflowForm';
import { synthesizeSteps } from './WorkflowStepsEditor';
import { memberName, useDriveAgents, useDriveMembers, usePageMeta, useWorkflowList } from './workflow-data';
import {
  hasSchedule,
  nextRunDateText,
  relativeRunText,
  scheduleText,
  stepViews,
  type StepView,
} from './workflow-view-model';
import type { Workflow } from './types';

const cardClass = 'rounded-lg border border-border p-4';
const cardLabelClass = 'mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground';

/** A page's title as a link to the page; the chip reads "Loading…" until the title arrives. */
function PageLink({ pageId }: { pageId: string }) {
  const { data, error } = usePageMeta(pageId);
  const label = error ? 'Unknown page' : data?.title ?? 'Loading…';
  return (
    <Link href={`/p/${pageId}`} className="text-primary hover:underline" title={label}>
      {label}
    </Link>
  );
}

export type WorkflowDetailViewProps = {
  readonly workflow: Workflow;
  readonly spendContext?: AutomationSpendContext;
  readonly agentTitle: string | null;
  /** False while the drive's agents are still loading, so a name is not reported missing too early. */
  readonly agentsLoaded: boolean;
  readonly agentTitles: ReadonlyMap<string, string>;
  readonly createdByName: string | null;
  readonly running: boolean;
  readonly toggling: boolean;
  readonly now: Date;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRun: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
};

/** One workflow, read-only, with its switch and its two actions. */
export function WorkflowDetailView({
  workflow,
  agentTitle,
  agentsLoaded,
  agentTitles,
  createdByName,
  spendContext,
  running,
  toggling,
  now,
  onToggle,
  onRun,
  onEdit,
  onDelete,
}: WorkflowDetailViewProps) {
  const steps: readonly StepView[] = stepViews(synthesizeSteps(workflow), agentTitles, workflow.agentPageId);
  const ownerLeft = Boolean(workflow.ownerLeftAt);
  const nextRunAt = !ownerLeft && workflow.isEnabled && workflow.nextRunAt ? new Date(workflow.nextRunAt) : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight">{workflow.name}</h1>
          {spendContext || ownerLeft ? <AutomationSpendLine creatorName={createdByName} walletLabel={spendContext?.walletLabel ?? null} ownerLeft={ownerLeft} /> : createdByName ? <p className="mt-1 text-sm text-muted-foreground">Created by {createdByName}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch aria-label="Enabled" checked={workflow.isEnabled && !ownerLeft} onCheckedChange={onToggle} disabled={toggling || ownerLeft} />
            Enabled
          </label>
          <Button variant="outline" onClick={onEdit}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" />
            Edit workflow
          </Button>
          <Button onClick={onRun} disabled={running || ownerLeft}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Run workflow
          </Button>
          <Button variant="ghost" onClick={onDelete} aria-label={`Delete ${workflow.name}`}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {hasSchedule(workflow) && workflow.cronExpression ? (
          <section aria-label="Schedule" className={cardClass}>
            <div className={cardLabelClass}>Schedule</div>
            <div className="font-medium">{scheduleText(workflow.cronExpression)}</div>
            <div className="mt-1 font-mono text-xs text-muted-foreground">
              {workflow.cronExpression} · {workflow.timezone}
            </div>
            {nextRunAt ? (
              <div className="mt-3 border-t border-border pt-3 text-sm">
                <span className={cardLabelClass}>Next run</span>
                <div>{nextRunDateText(nextRunAt)}</div>
                <div className="text-xs text-muted-foreground">{relativeRunText(nextRunAt, now)}</div>
              </div>
            ) : null}
          </section>
        ) : null}
        <section aria-label="Agent" className={cardClass}>
          <div className={cardLabelClass}>Agent</div>
          {workflow.agentPageId === null ? (
            <span className="text-muted-foreground">No agent</span>
          ) : agentTitle !== null ? (
            <Link href={`/p/${workflow.agentPageId}`} className="font-medium text-primary hover:underline">
              {agentTitle}
            </Link>
          ) : (
            <span className="text-muted-foreground">{agentsLoaded ? 'Agent not in this drive' : 'Loading…'}</span>
          )}
          {workflow.instructionPageId ? (
            <div className="mt-3 text-sm">
              <span className="text-muted-foreground">Instructions: </span>
              <PageLink pageId={workflow.instructionPageId} />
            </div>
          ) : null}
        </section>
      </div>

      <section aria-label="Context pages" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Context pages</h3>
        {workflow.contextPageIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">No context pages</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {workflow.contextPageIds.map((pageId) => (
              <Badge key={pageId} variant="secondary" className="font-normal">
                <PageLink pageId={pageId} />
              </Badge>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Steps" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold">Steps</h3>
          <span className="text-xs text-muted-foreground">Tool steps run without a model; AI steps use the agent.</span>
        </div>
        <ol className="divide-y divide-border rounded-lg border border-border">
          {steps.map((step) => (
            <li key={step.n} className="flex items-start gap-3 p-3">
              <span className="w-5 text-right font-mono text-xs text-muted-foreground">{step.n}</span>
              <Badge variant="outline" className="font-normal">{step.kind}</Badge>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{step.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** The query string the middle's selection and form state live in. */
const withQuery = (params: Readonly<Record<string, string>>): string => {
  const query = new URLSearchParams(params).toString();
  return query === '' ? '?' : `?${query}`;
};

/**
 * The Workflows middle: the workflow the URL selects (?id=), read-only, with Edit and Run. ?new=1
 * opens the create form. The list lives in the shell's pane.
 */
export function WorkflowDetail({ driveId }: { readonly driveId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const selectedId = search.get('id');
  const creating = search.get('new') === '1';
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { data: workflows, error, isLoading, mutate } = useWorkflowList(driveId);
  const spendContext = useAutomationSpendContext(driveId);
  const { data: agents } = useDriveAgents(driveId);
  const { data: membersData } = useDriveMembers(driveId);

  const workflow = workflows?.find((entry) => entry.id === selectedId) ?? null;
  const agentTitles = new Map((agents ?? []).map((agent) => [agent.id, agent.title]));
  const members = membersData?.members ?? [];
  const formOpen = creating || (editing && workflow !== null);

  const closeNew = () => router.replace(withQuery(selectedId ? { id: selectedId } : {}));

  const handleRun = async () => {
    if (!workflow || workflow.ownerLeftAt) return;
    setRunning(true);
    try {
      const result = await post<{ success: boolean; error?: string }>(`/api/workflows/${workflow.id}/run`);
      if (result.success) toast.success('Workflow executed successfully');
      else toast.error(result.error || 'Workflow execution failed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run workflow');
    } finally {
      setRunning(false);
      void mutate();
    }
  };

  const handleToggle = async (enabled: boolean) => {
    if (!workflow || (enabled && workflow.ownerLeftAt)) return;
    setToggling(true);
    try {
      await patch(`/api/workflows/${workflow.id}`, { isEnabled: enabled });
      toast.success(enabled ? 'Workflow enabled' : 'Workflow disabled');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update workflow');
    } finally {
      setToggling(false);
      void mutate();
    }
  };

  const handleCreate = async (data: WorkflowFormData) => {
    const created = await post<Workflow & { warnings?: string[] }>('/api/workflows', { ...data, driveId });
    toast.success('Workflow created');
    created.warnings?.forEach((warning) => toast.warning(warning, { duration: 10000 }));
    await mutate();
    router.replace(withQuery({ id: created.id }));
  };

  const handleUpdate = async (data: WorkflowFormData) => {
    if (!workflow) return;
    const updated = await patch<{ warnings?: string[] }>(`/api/workflows/${workflow.id}`, data);
    toast.success('Workflow updated');
    updated.warnings?.forEach((warning) => toast.warning(warning, { duration: 10000 }));
    await mutate();
  };

  const handleDelete = async () => {
    if (!workflow) return;
    try {
      await del(`/api/workflows/${workflow.id}`);
      toast.success('Workflow deleted');
      await mutate();
      router.replace(withQuery({}));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete workflow');
    }
  };

  let body: ReactNode;
  if (workflow) {
    body = (
      <WorkflowDetailView
        workflow={workflow}
        spendContext={spendContext}
        agentTitle={workflow.agentPageId ? agentTitles.get(workflow.agentPageId) ?? null : null}
        agentsLoaded={agents !== undefined}
        agentTitles={agentTitles}
        createdByName={memberName(members, workflow.createdBy)}
        running={running}
        toggling={toggling}
        now={new Date()}
        onToggle={handleToggle}
        onRun={handleRun}
        onEdit={() => setEditing(true)}
        onDelete={() => setDeleting(true)}
      />
    );
  } else if (error) {
    body = <p className="p-6 text-sm text-muted-foreground">Could not load workflows.</p>;
  } else if (isLoading) {
    body = <p className="p-6 text-sm text-muted-foreground">Loading workflow…</p>;
  } else if (selectedId) {
    body = <p className="p-6 text-sm text-muted-foreground">This workflow is not in the drive’s list.</p>;
  } else {
    body = <p className="p-6 text-sm text-muted-foreground">Pick a workflow from the list, or create one.</p>;
  }

  return (
    <div className="h-full overflow-y-auto">
      {body}
      {workflow ? (
        <DeleteWorkflowDialog workflowName={workflow.name} open={deleting} onOpenChange={setDeleting} onConfirm={handleDelete} />
      ) : null}
      {formOpen ? (
        <WorkflowForm
          open
          onOpenChange={(open) => {
            if (open) return;
            setEditing(false);
            if (creating) closeNew();
          }}
          driveId={driveId}
          initialData={creating || !workflow ? undefined : {
            id: workflow.id,
            name: workflow.name,
            steps: synthesizeSteps(workflow),
            contextPageIds: workflow.contextPageIds ?? [],
            cronExpression: workflow.cronExpression ?? '0 9 * * 1-5',
            timezone: workflow.timezone,
            isEnabled: workflow.isEnabled,
          }}
          onSubmit={creating ? handleCreate : handleUpdate}
        />
      ) : null}
    </div>
  );
}
