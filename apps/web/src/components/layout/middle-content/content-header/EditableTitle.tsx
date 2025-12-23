'use client';

import { useState, useEffect, useRef } from 'react';
import { useSWRConfig } from 'swr';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { usePageTree } from '@/hooks/usePageTree';
import { useParams } from 'next/navigation';
import { patch } from '@/lib/auth/auth-fetch';

export function EditableTitle() {
  const { mutate } = useSWRConfig();
  const params = useParams();
  const pageId = params.pageId as string | undefined;
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
      toast.success('Title updated successfully');
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
        className="text-2xl font-bold h-auto p-0 border-none focus-visible:ring-0"
      />
    );
  }

  return (
    <h1 onClick={handleTitleClick} className="text-2xl font-bold cursor-pointer">
      {page?.title}
    </h1>
  );
}