'use client';

import dynamic from 'next/dynamic';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { isRichContentEmpty, usePageContent } from '@/hooks/usePageContent';

const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });

export const getInitialOpenState = (content: string | null): boolean =>
  !isRichContentEmpty(content);

interface TaskListDescriptionHeaderProps {
  open: boolean;
  onToggle: () => void;
}

export function TaskListDescriptionHeader({ open, onToggle }: TaskListDescriptionHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1.5 px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full text-left shrink-0"
    >
      {open ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
      )}
      Description
    </button>
  );
}

interface TaskListDescriptionContentProps {
  pageId: string;
  canEdit: boolean;
  initialContent: string | null;
  className?: string;
}

export function TaskListDescriptionContent({
  pageId,
  canEdit,
  initialContent,
  className,
}: TaskListDescriptionContentProps) {
  const { content, save } = usePageContent({ pageId, initialContent });

  return (
    <div className={className}>
      <RichEditor
        value={content ?? ''}
        onChange={save}
        readOnly={!canEdit}
        contentMode="html"
      />
    </div>
  );
}
