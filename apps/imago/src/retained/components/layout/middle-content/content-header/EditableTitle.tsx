'use client';

import { useState, useEffect, useRef } from 'react';
import { useSWRConfig } from 'swr';
import { findNodeAndParent } from '@/retained/lib/tree/tree-utils';
import { usePageStore } from '@/retained/hooks/usePage';
import { Input } from '@/retained/components/ui/input';
import { toast } from 'sonner';
import { usePageTree } from '@/retained/hooks/usePageTree';
import { useParams } from '@/retained-adapters/navigation';
import { patch } from '@/retained/lib/auth/auth-fetch';
import { useTabsStore } from '@/retained/stores/useTabsStore';

/** The classic header's title, or the v3 in-body title (34–40px, the board's document h1). */
export type EditableTitleVariant = 'header' | 'body';

const titleClass: Record<EditableTitleVariant, { readonly text: string; readonly input: string }> = {
  header: {
    text: 'text-lg @[400px]:text-2xl font-bold cursor-pointer truncate max-w-[150px] @[400px]:max-w-[400px] @[600px]:max-w-[600px]',
    input: 'text-lg @[400px]:text-2xl font-bold h-auto p-0 border-none focus-visible:ring-0',
  },
  body: {
    text: 'text-[40px] leading-[1.12] tracking-[-0.025em] font-bold cursor-pointer break-words',
    input: 'text-[40px] leading-[1.12] tracking-[-0.025em] font-bold h-auto p-0 border-none focus-visible:ring-0',
  },
};

export function EditableTitle({ pageId: propPageId, variant = 'header' }: { pageId?: string | null; variant?: EditableTitleVariant } = {}) {
  const storePageId = usePageStore((state) => state.pageId);
  const pageId = propPageId !== undefined ? propPageId : storePageId;
  const { mutate } = useSWRConfig();
  const params = useParams();
  const driveId = params.driveId as string;
  const { tree, updateNode, isLoading } = usePageTree(driveId);
  const pageResult = pageId ? findNodeAndParent(tree, pageId) : null;
  const page = pageResult?.node;
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(page?.title || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (page) {
      setTitle(page.title);
    }
  }, [page]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleTitleClick = () => {
    if (!isLoading) {
      setIsEditing(true);
    }
  };

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
  };

  const updateTitle = async () => {
    if (!page || title === page.title || isLoading) {
      setIsEditing(false);
      return;
    }

    try {
      const updatedPage = await patch<{ id: string; title: string }>(`/api/pages/${page.id}`, { title });
      updateNode(updatedPage.id, { title: updatedPage.title });
      mutate(`/api/pages/${page.id}/breadcrumbs`);

      // Update tab titles (single batched update)
      useTabsStore.getState().updateTabMetaByPageId(updatedPage.id, { title: updatedPage.title });
    } catch (error) {
      console.error(error);
      toast.error('Failed to update title');
      // Revert title on error
      setTitle(page.title);
    } finally {
      setIsEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      updateTitle();
    } else if (e.key === 'Escape') {
      setTitle(page?.title || '');
      setIsEditing(false);
    }
  };

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        value={title}
        onChange={handleTitleChange}
        onBlur={updateTitle}
        onKeyDown={handleKeyDown}
        className={titleClass[variant].input}
      />
    );
  }

  return (
    <h1
      onClick={handleTitleClick}
      className={titleClass[variant].text}
      title={page?.title || ''}
    >
      {page?.title}
    </h1>
  );
}