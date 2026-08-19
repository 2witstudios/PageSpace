'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import { usePageContent } from '@/hooks/usePageContent';
import { TaskItem } from './task-list-types';
import { TASK_TABLE_COLUMN_COUNT } from './table-columns';
import { depthIndentStyle } from './task-tree-core';

const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });

interface TaskDocumentRowProps {
  task: TaskItem;
  depth: number;
}

export const shouldShowPlaceholder = (pageId: string | null | undefined): boolean => !pageId;

export const shouldShowSkeleton = (isLoading: boolean, content: string | null): boolean =>
  isLoading && content === null;

/**
 * The linked page's document, shown when a task is expanded.
 *
 * Owns its whole `<tr>` so that `<tbody>` validity — only `<tr>` children, no
 * wrappers — lives in one place rather than at every call site.
 *
 * Previously this was clamped to `max-h-[120px] overflow-hidden` with a fade
 * gradient: about three lines of a document and a visual apology, not enough to
 * read and not enough to act on. It now renders in full. Sub-tasks used to
 * share this box as a list of dead links; they are real sibling rows now.
 */
export function TaskDocumentRow({ task, depth }: TaskDocumentRowProps) {
  const { content, isLoading } = usePageContent({
    pageId: task.pageId ?? null,
    enabled: !!task.pageId,
  });

  return (
    <tr>
      <td colSpan={TASK_TABLE_COLUMN_COUNT} className="px-4 py-2 border-b bg-muted/20">
        <div style={depthIndentStyle(depth + 1)}>
          {shouldShowPlaceholder(task.pageId) ? (
            <p className="text-sm text-muted-foreground italic px-1">No linked page</p>
          ) : shouldShowSkeleton(isLoading, content) ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <RichEditor value={content ?? ''} readOnly contentMode="html" />
          )}
        </div>
      </td>
    </tr>
  );
}
