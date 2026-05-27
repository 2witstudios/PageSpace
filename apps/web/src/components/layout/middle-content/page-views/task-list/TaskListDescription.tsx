'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { isRichContentEmpty, usePageContent } from '@/hooks/usePageContent';

const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });

interface TaskListDescriptionProps {
  pageId: string;
  canEdit: boolean;
  initialContent: string | null;
}

export const getInitialOpenState = (content: string | null): boolean =>
  !isRichContentEmpty(content);

export function TaskListDescription({ pageId, canEdit, initialContent }: TaskListDescriptionProps) {
  const [open, setOpen] = useState(() => getInitialOpenState(initialContent));
  const { content, save } = usePageContent({ pageId, initialContent });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full text-left"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          Description
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pb-3">
          <RichEditor
            value={content ?? ''}
            onChange={save}
            readOnly={!canEdit}
            contentMode="html"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
