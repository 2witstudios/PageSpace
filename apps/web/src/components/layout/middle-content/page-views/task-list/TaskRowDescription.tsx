'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { LayoutList, Circle, CheckCircle2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { usePageContent } from '@/hooks/usePageContent';
import { TaskItem } from './task-list-types';
import { useTaskSubTasks } from './useTaskSubTasks';

const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });

interface TaskRowDescriptionProps {
  task: TaskItem;
  driveId: string;
}

export const shouldShowPlaceholder = (pageId: string | null | undefined): boolean => !pageId;

export const shouldShowSkeleton = (isLoading: boolean, content: string | null): boolean =>
  isLoading && content === null;

/**
 * `TaskItem.pageId` is nullable, and a task whose linked page is gone has nowhere to navigate
 * to. Interpolating it anyway yields `/dashboard/{driveId}/null` — a link that looks live and
 * lands on a dead route. `null` here means "render the row, but not as a link".
 */
export const subTaskHref = (driveId: string, pageId: string | null | undefined): string | null =>
  pageId ? `/dashboard/${driveId}/${pageId}` : null;

export function TaskRowDescription({ task, driveId }: TaskRowDescriptionProps) {
  const { content, isLoading } = usePageContent({
    pageId: task.pageId ?? null,
    enabled: !!task.pageId,
  });

  // Gated on task.subTaskCount inside the hook: a leaf task issues no request at
  // all, which also keeps the route from lazily creating a task_list + 4 status
  // configs for it. See useTaskSubTasks.
  const { subTasks, hasMore, isLoading: isLoadingSubTasks, isLoadingMore, loadMore, error } =
    useTaskSubTasks(task);

  const subTaskCount = task.subTaskCount ?? 0;

  if (shouldShowPlaceholder(task.pageId)) {
    return (
      <p className="text-sm text-muted-foreground italic px-1">No linked page</p>
    );
  }

  return (
    <div className="space-y-1.5">
      {subTaskCount > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-1">
            <LayoutList className="h-3 w-3" />
            <span>{subTaskCount} sub-task{subTaskCount !== 1 ? 's' : ''}</span>
          </div>
          {isLoadingSubTasks ? (
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
          {/* The header above has already told the user this task has N sub-tasks, so an empty
              list under that count reads as "there are none" — the one thing that is definitely
              not true. Both ways of getting there say what actually happened: the fetch failed,
              or the children went away between the parent list loading and this expansion. */}
          {!isLoadingSubTasks && (error || subTasks.length === 0) && (
            <p className="px-1 text-xs text-muted-foreground italic">
              {error ? 'Could not load sub-tasks.' : 'These sub-tasks are no longer here.'}
            </p>
          )}
          {hasMore && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1 text-xs text-muted-foreground"
              disabled={isLoadingMore}
              onClick={loadMore}
            >
              {isLoadingMore ? 'Loading…' : 'Load more sub-tasks'}
            </Button>
          )}
        </div>
      )}
      {shouldShowSkeleton(isLoading, content) ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="relative max-h-[120px] overflow-hidden">
          <RichEditor
            value={content ?? ''}
            readOnly
            contentMode="html"
          />
          <div className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-muted/30 to-transparent pointer-events-none" />
        </div>
      )}
    </div>
  );
}
