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
import { IconButton } from '../../components/icon-button/icon-button';
import type { TaskStatus } from '../task-model/task';

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
 * The status rows as the classic manager edits them. Its PUT sends each row
 * back whole, so the limit is left off: the server keeps a row's stored limit
 * when none is sent, where echoing ours could wipe one set since we loaded.
 */
export const configsOf = (pageId: string, statuses: readonly TaskStatus[]): TaskStatusConfig[] =>
  statuses.map(({ wipLimit: _wipLimit, ...status }) => ({ ...status, taskListId: pageId }));

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
          <IconButton name="workflow" label="Workflows" onClick={() => setWorkflowsOpen(true)} />
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
