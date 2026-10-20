'use client';

// The strip's two dialogs that are still classic's (docs/imago/reuse-
// inventory.md): editing a list's statuses, and the drive Workflows scoped
// to the list. Each is mounted in a retained surface, so its classic styles
// and portals apply, and only for a viewer the server lets use it.

import { useState, type ReactNode } from 'react';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import { StatusConfigManager } from '@/retained/components/layout/middle-content/page-views/task-list/StatusConfigManager';
import { TaskListWorkflowsDialog } from '@/retained/components/layout/middle-content/page-views/task-list/TaskListWorkflowsDialog';
import type { TaskStatusConfig } from '@/retained/components/layout/middle-content/page-views/task-list/task-list-types';
import { canManageDrive } from '@/retained/hooks/usePermissions';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { Icon } from '../../components/icon/icon';
import type { TaskStatus } from '../task-model/task';
import { taskStripButtonClass } from './task-list-view-class';

export type TaskListToolsProps = {
  readonly driveId: string;
  readonly pageId: string;
  readonly title: string;
  /** The list's own statuses; empty while it uses PageSpace's four defaults. */
  readonly statuses: readonly TaskStatus[];
  readonly editable: boolean;
  /** Void action: asks the server for the list again once statuses change. */
  readonly revalidate: () => void;
};

/**
 * The status rows as the classic manager edits them. The limit rides along
 * so its PUT, which sends each row back whole, keeps every column's limit.
 */
const configsOf = (pageId: string, statuses: readonly TaskStatus[]): TaskStatusConfig[] =>
  statuses.map((status) => ({ ...status, taskListId: pageId }));

export function TaskListTools({ driveId, pageId, title, statuses, editable, revalidate }: TaskListToolsProps): ReactNode {
  const drive = useDriveStore((state) => state.drives.find((entry) => entry.id === driveId));
  const workflows = canManageDrive(drive);
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  if (!editable && !workflows) return null;
  return (
    <>
      {editable ? (
        <RetainedSurface fill={false}>
          <StatusConfigManager
            pageId={pageId}
            statusConfigs={configsOf(pageId, statuses)}
            onConfigsChanged={revalidate}
            triggerLabel="Statuses"
          />
        </RetainedSurface>
      ) : null}
      {workflows ? (
        <>
          <button type="button" className={taskStripButtonClass} onClick={() => setWorkflowsOpen(true)}>
            <Icon name="workflow" size={14} />
            Workflows
          </button>
          <RetainedSurface fill={false}>
            <TaskListWorkflowsDialog
              open={workflowsOpen}
              onOpenChange={setWorkflowsOpen}
              driveId={driveId}
              pageId={pageId}
              taskListTitle={title}
            />
          </RetainedSurface>
        </>
      ) : null}
    </>
  );
}
