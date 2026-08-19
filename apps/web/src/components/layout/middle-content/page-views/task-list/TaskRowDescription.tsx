'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import { usePageContent } from '@/hooks/usePageContent';
import { TaskItem } from './task-list-types';
import { TaskSubTaskList } from './TaskSubTaskList';

const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });

interface TaskRowDescriptionProps {
  task: TaskItem;
  driveId: string;
}

export const shouldShowPlaceholder = (pageId: string | null | undefined): boolean => !pageId;

export const shouldShowSkeleton = (isLoading: boolean, content: string | null): boolean =>
  isLoading && content === null;

export function TaskRowDescription({ task, driveId }: TaskRowDescriptionProps) {
  const { content, isLoading } = usePageContent({
    pageId: task.pageId ?? null,
    enabled: !!task.pageId,
  });

  if (shouldShowPlaceholder(task.pageId)) {
    return (
      <p className="text-sm text-muted-foreground italic px-1">No linked page</p>
    );
  }

  return (
    <div className="space-y-1.5">
      <TaskSubTaskList task={task} driveId={driveId} />
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
