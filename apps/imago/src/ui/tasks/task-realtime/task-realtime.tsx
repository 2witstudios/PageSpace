'use client';

// Keeps an open task tree current with everyone else's edits. apps/web
// broadcasts each task write (task:task_added, task_updated, task_deleted,
// tasks_reordered) to the room of the list page the write landed in, and a
// subtask lands in its parent task's own page, so the tree joins the room of
// every task page it has loaded, not only its root's.

import { useEffect, useRef, type ReactNode } from 'react';
import { useSWRConfig } from 'swr';
import { CHANNEL_ROOM, useRooms, useSocketEvent } from '@/realtime/realtime-provider';
import type { TaskList } from '../task-model/task';

/** The task events apps/web's broadcastTaskEvent sends, as `task:${type}`. */
export const TASK_EVENTS = ['task:task_added', 'task:task_updated', 'task:task_deleted', 'task:tasks_reordered'] as const;

/**
 * Every page a write to the tree can land in: the root list and each loaded
 * task's own page, which is where its subtasks go, so a first subtask added
 * elsewhere under a leaf still reaches this tab.
 */
export const treeRooms = (list: TaskList): readonly string[] => [
  list.pageId,
  ...list.tasks.flatMap((task) => (task.subtasks === null ? [task.pageId] : treeRooms(task.subtasks))),
];

type TaskEventPayload = { readonly pageId?: unknown };

/** Whether an event names one of the tree's lists; an event with no page is taken to be the tree's own. */
export const concernsTree = (payload: unknown, rooms: readonly string[]): boolean => {
  if (typeof payload !== 'object' || payload === null) return true;
  const { pageId } = payload as TaskEventPayload;
  return typeof pageId !== 'string' || rooms.includes(pageId);
};

/** How long a burst of task events is gathered before the tree refetches once. */
export const COALESCE_MS = 300;

export type Coalescer = {
  /** Asks for a run; every ask inside one window shares the run at its end. */
  readonly schedule: () => void;
  /** Drops a pending run, for unmount. */
  readonly cancel: () => void;
};

/**
 * One trailing `run` per `waitMs` window however many times it is scheduled.
 * The window opens at the first ask and is not pushed back by later ones, so
 * a steady stream of events still refetches every `waitMs`.
 */
export const createCoalescer = (run: () => void, waitMs: number): Coalescer => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule: () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, waitMs);
    },
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
};

function TaskEvent({ event, onEvent }: { readonly event: string; readonly onEvent: (payload: unknown) => void }) {
  useSocketEvent<[unknown]>(event, onEvent);
  return null;
}

/**
 * Joins the rooms of `tree`'s lists and revalidates the tree's SWR entry
 * when one of them changes. Each write arrives more than once: apps/web
 * sends it to the writer's own tasks channel, which every one of their
 * sockets is in, and to the list's room, and our own writes echo back too.
 * SWR's `mutate(key)` does not dedupe, so the events of a burst are
 * gathered into one trailing refetch per COALESCE_MS.
 */
export function TaskTreeRealtime({ rootPageId, tree }: { readonly rootPageId: string; readonly tree: TaskList | undefined }): ReactNode {
  const { mutate } = useSWRConfig();
  const rooms = tree === undefined ? [rootPageId] : treeRooms(tree);
  useRooms(CHANNEL_ROOM, rooms);
  const coalescer = useRef<Coalescer | null>(null);
  useEffect(() => {
    const created = createCoalescer(() => void mutate(['imago:task-tree', rootPageId]), COALESCE_MS);
    coalescer.current = created;
    return created.cancel;
  }, [mutate, rootPageId]);
  const onEvent = (payload: unknown) => {
    if (concernsTree(payload, rooms)) coalescer.current?.schedule();
  };
  return (
    <>
      {TASK_EVENTS.map((event) => (
        <TaskEvent key={event} event={event} onEvent={onEvent} />
      ))}
    </>
  );
}
