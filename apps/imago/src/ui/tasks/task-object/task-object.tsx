'use client';

import type { ReactNode } from 'react';
import { edgeOf, renderErrorState } from '../../frame/edge-state/edge-state.render';
import { TaskDetail, renderTaskNotFound } from '../task-detail/task-detail';
import { renderTaskDetailMessage } from '../task-detail/task-detail.render';
import { PageView } from '@/ui/files/page-view/page-view';
import { PageObject } from '@/ui/files/page-object/page-object';
import { useDriveTaskLists, usePageTrail } from '../use-tasks/use-tasks';
import { taskHref, taskRoute } from './task-route';

export type TaskObjectProps = {
  readonly driveId: string;
  /** The route's id: one of the drive's task lists, or a task's own page. */
  readonly pageId: string;
  /** Whose view choice a list restores. */
  readonly viewerId: string;
};

/**
 * What /imago/[driveId]/tasks/[pageId] opens in the object slot: a task list
 * as its view, or a task as its detail inside the list holding it. Where a
 * page sits is only asked when it is not one of the drive's lists.
 */
export function TaskObject({ driveId, pageId }: TaskObjectProps): ReactNode {
  const { lists, error: listsError, retry: retryLists } = useDriveTaskLists(driveId);
  const isList = lists?.some((entry) => entry.pageId === pageId) === true;
  const { trail, error: trailError, retry: retryTrail } = usePageTrail(lists === undefined || isList ? null : pageId);
  if (lists === undefined && listsError !== undefined) {
    return renderErrorState({ title: 'Could not load this task', retry: retryLists });
  }
  // Ancestors the server refuses or does not know name nothing here; any
  // other failure is worth asking again.
  if (!isList && trailError !== undefined && edgeOf(trailError) === 'error') {
    return renderErrorState({ title: 'Could not load this task', retry: retryTrail });
  }
  const route = taskRoute(pageId, lists, trailError === undefined ? trail : null);
  switch (route.kind) {
    case 'loading':
      return renderTaskDetailMessage('Loading task…', 'status');
    case 'missing':
      return renderTaskNotFound(driveId);
    case 'list':
      return <PageObject driveId={driveId} pageId={pageId}><PageView driveId={driveId} pageId={pageId} /></PageObject>;
    case 'task':
      return (
        <TaskDetail
          driveId={driveId}
          holder={route.list}
          pageId={pageId}
          hrefFor={(target) => taskHref(driveId, target)}
        />
      );
  }
}
