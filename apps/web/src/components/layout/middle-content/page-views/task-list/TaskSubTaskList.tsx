'use client';

import Link from 'next/link';
import { LayoutList, Circle, CheckCircle2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { TaskItem } from './task-list-types';
import { useTaskSubTasks } from './useTaskSubTasks';

interface TaskSubTaskListProps {
  task: TaskItem;
  /** Sub-task links are drive-scoped page URLs, and a task row carries no route to its drive. */
  driveId: string;
}

/**
 * `TaskItem.pageId` is typed `string | null` — WIDER than the database, where
 * `task_items.pageId` is genuinely `notNull()`. So this guard is not defending against data the
 * route can currently return; it is refusing to rely on a constraint the type in front of us
 * contradicts. Interpolating a null anyway yields `/dashboard/{driveId}/null`: a link that looks
 * live and lands on a dead route. `null` here means "render the row, but not as a link".
 */
export const subTaskHref = (driveId: string, pageId: string | null | undefined): string | null =>
  pageId ? `/dashboard/${driveId}/${pageId}` : null;

/**
 * The sub-tasks half of an expanded task row: a count, the children as links, and paging.
 *
 * Separate from TaskRowDescription because the two halves of the expansion answer to different
 * things — this one to the sub-task fetch, the other to the linked page's document — and the
 * epic's next step branches between them.
 */
export function TaskSubTaskList({ task, driveId }: TaskSubTaskListProps) {
  // Gated on task.subTaskCount inside the hook: a leaf task issues no request at all, which
  // also keeps the route from lazily creating a task_list + 4 status configs for it.
  const { subTasks, hasMore, isLoading, isLoadingMore, loadMore, retry, error } = useTaskSubTasks(task);

  const subTaskCount = task.subTaskCount ?? 0;
  if (subTaskCount === 0) return null;

  // `task.subTaskCount` rode in on the PARENT list's response, which does revalidate (socket
  // events, 5-minute interval) while this list does not. So the two can drift — someone adds a
  // sub-task and the header says 4 over a list of 3, indefinitely and silently. Once this list
  // is settled and complete, it is the fresher of the two: report what is actually here rather
  // than a count that outranks the rows under it. While paging, the total is still the honest
  // number, because the rows are deliberately partial.
  const listIsComplete = !isLoading && !error && !hasMore;
  const shownCount = listIsComplete ? subTasks.length : subTaskCount;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-1">
        <LayoutList className="h-3 w-3" />
        <span>{shownCount} sub-task{shownCount !== 1 ? 's' : ''}</span>
      </div>

      {isLoading ? (
        <Skeleton className="h-8 w-full" />
      ) : (
        <ul className="space-y-0.5">
          {subTasks.map((subTask) => {
            const href = subTaskHref(driveId, subTask.pageId);
            const body = (
              <>
                {subTask.completedAt
                  ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  : <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className={subTask.completedAt ? 'line-through text-muted-foreground' : ''}>
                  {subTask.title}
                </span>
              </>
            );
            return (
              <li key={subTask.id}>
                {href ? (
                  <Link
                    href={href}
                    className="flex items-center gap-1.5 px-1 py-0.5 rounded text-sm hover:bg-muted/60 hover:underline"
                  >
                    {body}
                  </Link>
                ) : (
                  <span className="flex items-center gap-1.5 px-1 py-0.5 rounded text-sm text-muted-foreground">
                    {body}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* An expanded row that shows nothing has to say why — it was expandable precisely
          because a count said there was something here. Each way of arriving at an empty or
          short list says which one it was: the fetch failed outright, a later page failed after
          some rows were already shown, or the children went away between the parent list
          loading and this expansion. (In that last case the header above has already corrected
          itself to 0 via shownCount; this explains the 0.) */}
      {!isLoading && (error || subTasks.length === 0) && (
        <p className="px-1 text-xs text-muted-foreground italic">
          {error
            ? (subTasks.length > 0 ? 'Could not load the rest of the sub-tasks.' : 'Could not load sub-tasks.')
            : 'These sub-tasks are no longer here.'}
        </p>
      )}

      {/* Shown on `error` even when there is nothing more to load: a FIRST page that failed
          leaves hasMore false, and since nothing retries on its own (see the hook's
          shouldRetryOnError) a missing control there would be a dead end.

          Which recovery to use depends on WHICH page failed, and the difference is requests
          against a route that writes. `retry` is SWR's revalidate-all, so with pages already
          loaded it would re-issue every one of them. Paging forward re-requests only the page
          that is missing. So: retry when nothing loaded (there is nothing else to re-request),
          page forward when the failure came after some rows arrived. */}
      {(hasMore || error) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1 text-xs text-muted-foreground"
          disabled={isLoadingMore}
          onClick={error && subTasks.length === 0 ? retry : loadMore}
        >
          {isLoadingMore ? 'Loading…' : error ? 'Try again' : 'Load more sub-tasks'}
        </Button>
      )}
    </div>
  );
}
