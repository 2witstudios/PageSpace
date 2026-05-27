'use client';

import dynamic from 'next/dynamic';
import { LayoutList } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { usePageContent } from '@/hooks/usePageContent';
import { TaskItem } from './task-list-types';

const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });

interface TaskRowDescriptionProps {
  task: TaskItem;
}

export const shouldShowPlaceholder = (pageId: string | null | undefined): boolean => !pageId;

export const shouldShowSkeleton = (isLoading: boolean, content: string | null): boolean =>
  isLoading && content === null;

export function TaskRowDescription({ task }: TaskRowDescriptionProps) {
  const { content, isLoading } = usePageContent({
    pageId: task.pageId ?? null,
    enabled: !!task.pageId,
  });

  const subTaskCount = task.subTaskCount ?? 0;

  if (shouldShowPlaceholder(task.pageId)) {
    return (
      <p className="text-sm text-muted-foreground italic px-1">No linked page</p>
    );
  }

  return (
    <div className="space-y-1.5">
      {subTaskCount > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-1">
          <LayoutList className="h-3 w-3" />
          <span>{subTaskCount} sub-task{subTaskCount !== 1 ? 's' : ''}</span>
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
