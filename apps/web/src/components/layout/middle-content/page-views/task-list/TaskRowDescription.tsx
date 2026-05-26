'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import { usePageContent } from '@/hooks/usePageContent';
import { TaskItem } from './task-list-types';

const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });

interface TaskRowDescriptionProps {
  task: TaskItem;
  canEdit: boolean;
}

export const shouldShowPlaceholder = (pageId: string | null | undefined): boolean => !pageId;

export const shouldShowSkeleton = (isLoading: boolean, content: string | null): boolean =>
  isLoading && content === null;

export function TaskRowDescription({ task, canEdit }: TaskRowDescriptionProps) {
  const { content, isLoading, save } = usePageContent({
    pageId: task.pageId ?? null,
    enabled: !!task.pageId,
  });

  if (shouldShowPlaceholder(task.pageId)) {
    return (
      <p className="text-sm text-muted-foreground italic px-1">No linked page</p>
    );
  }

  if (shouldShowSkeleton(isLoading, content)) {
    return <Skeleton className="h-16 w-full" />;
  }

  return (
    <div className="min-h-[80px] max-h-[400px] overflow-y-auto">
      <RichEditor
        value={content ?? ''}
        onChange={save}
        readOnly={!canEdit}
        contentMode="html"
      />
    </div>
  );
}
