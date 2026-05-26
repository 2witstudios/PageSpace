'use client';

import { useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Editor } from '@tiptap/react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { patch } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { isRichContentEmpty } from '@/hooks/usePageContent';
import { createId } from '@paralleldrive/cuid2';

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
  const [content, setContent] = useState(initialContent ?? '');
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sessionId] = useState(() => createId());

  const handleChange = useCallback(
    (html: string) => {
      setContent(html);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      useEditingStore.getState().startEditing(sessionId, 'document', { pageId });
      saveTimeoutRef.current = setTimeout(async () => {
        try {
          await patch(`/api/pages/${pageId}`, { content: html });
        } finally {
          useEditingStore.getState().endEditing(sessionId);
        }
      }, 1000);
    },
    [pageId, sessionId]
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleEditorChange = useCallback((_editor: Editor | null) => {}, []);

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
            value={content}
            onChange={handleChange}
            onEditorChange={handleEditorChange}
            readOnly={!canEdit}
            contentMode="html"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
