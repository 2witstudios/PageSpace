'use client';

// Keeps an open task tree current with everyone else's edits. apps/web
// broadcasts each task write (task:task_added, task_updated, task_deleted,
// tasks_reordered) to the room of the list page the write landed in, and a
// subtask lands in its parent task's own page, so the tree joins the room of
// every list it has loaded, not only its root's.

import type { ReactNode } from 'react';
import { useSWRConfig } from 'swr';
import { CHANNEL_ROOM, useRooms, useSocketEvent } from '@/realtime/realtime-provider';
import type { TaskList } from '../task-model/task';

/** The task events apps/web's broadcastTaskEvent sends, as `task:${type}`. */
export const TASK_EVENTS = ['task:task_added', 'task:task_updated', 'task:task_deleted', 'task:tasks_reordered'] as const;

/** Every list page a loaded tree holds: the root and each task's own page that has its subtasks loaded. */
export const treeRooms = (list: TaskList): readonly string[] => [
  list.pageId,
  ...list.tasks.flatMap((task) => (task.subtasks === null ? [] : treeRooms(task.subtasks))),
];

type TaskEventPayload = { readonly pageId?: unknown };

/** Whether an event names one of the tree's lists; an event with no page is taken to be the tree's own. */
export const concernsTree = (payload: unknown, rooms: readonly string[]): boolean => {
  if (typeof payload !== 'object' || payload === null) return true;
  const { pageId } = payload as TaskEventPayload;
  return typeof pageId !== 'string' || rooms.includes(pageId);
};

function TaskEvent({ event, onEvent }: { readonly event: string; readonly onEvent: (payload: unknown) => void }) {
  useSocketEvent<[unknown]>(event, onEvent);
  return null;
}

/**
 * Joins the rooms of `tree`'s lists and revalidates the tree's SWR entry
 * when one of them changes. Our own writes echo back too; SWR's dedupe
 * folds that refetch into the one the write already made.
 */
export function TaskTreeRealtime({ rootPageId, tree }: { readonly rootPageId: string; readonly tree: TaskList | undefined }): ReactNode {
  const { mutate } = useSWRConfig();
  const rooms = tree === undefined ? [rootPageId] : treeRooms(tree);
  useRooms(CHANNEL_ROOM, rooms);
  const onEvent = (payload: unknown) => {
    if (concernsTree(payload, rooms)) void mutate(['imago:task-tree', rootPageId]);
  };
  return (
    <>
      {TASK_EVENTS.map((event) => (
        <TaskEvent key={event} event={event} onEvent={onEvent} />
      ))}
    </>
  );
}
