'use client';

import type { ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useRouter } from '@/retained-adapters/navigation';
import { Icon } from '../../components/icon/icon';
import { useWorkflowList } from '@/retained/components/workflows/workflow-data';
import {
  lastRunLabel,
  lastRunTone,
  scheduleText,
} from '@/retained/components/workflows/workflow-view-model';
import type { Workflow } from '@/retained/components/workflows/types';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';
import {
  lastRunBadgeClass,
  newWorkflowClass,
  workflowRowClass,
  workflowRowHeadClass,
  workflowRowMetaClass,
  workflowRowNameClass,
  workflowsPaneMessageClass,
} from './workflows-pane-class';

function WorkflowRow({ workflow, selected }: { readonly workflow: Workflow; readonly selected: boolean }) {
  return (
    <Link
      href={`?id=${encodeURIComponent(workflow.id)}`}
      aria-current={selected ? 'page' : undefined}
      className={workflowRowClass(selected)}
    >
      <span className={workflowRowHeadClass}>
        <span className={workflowRowNameClass}>{workflow.name}</span>
        <span className={lastRunBadgeClass(lastRunTone(workflow.lastRun))}>{lastRunLabel(workflow.lastRun)}</span>
      </span>
      <span className={workflowRowMetaClass}>
        cron · {scheduleText(workflow.cronExpression)}
      </span>
    </Link>
  );
}

/** The Workflows tool's pane (C-Drive-Workflows): the drive's scheduled workflows; ?id= selects one. */
export function WorkflowsPane({ driveId, close }: ToolPaneProps): ReactNode {
  const router = useRouter();
  const selectedId = useSearchParams().get('id');
  const { data, error, isLoading } = useWorkflowList(driveId);

  let rows: ReactNode;
  if (error) rows = <p className={workflowsPaneMessageClass}>Could not load workflows.</p>;
  else if (isLoading || data === undefined) rows = <p className={workflowsPaneMessageClass}>Loading workflows…</p>;
  else if (data.length === 0) rows = <p className={workflowsPaneMessageClass}>No workflows yet.</p>;
  else {
    rows = data.map((workflow) => (
      <WorkflowRow key={workflow.id} workflow={workflow} selected={workflow.id === selectedId} />
    ));
  }

  return renderToolPane({
    title: 'Workflows',
    actions: (
      <button type="button" className={newWorkflowClass} onClick={() => router.push('?new=1')}>
        <Icon name="plus" />
        New
      </button>
    ),
    close,
    children: rows,
  });
}
