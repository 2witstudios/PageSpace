'use client';

import { useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { type Editor } from '@tiptap/react';
import { useDocument } from '@/hooks/useDocument';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useEditingStore } from '@/stores/useEditingStore';

const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });

export const isRichContentEmpty = (html: string | null): boolean => {
  if (!html) return true;
  return (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').trim().length === 0;
};

export const getInitialOpenState = (content: string | null): boolean =>
  !isRichContentEmpty(content);

interface TaskListDescriptionContentProps {
  pageId: string;
  canEdit: boolean;
  initialContent: string | null;
  className?: string;
  onEditorChange?: (editor: Editor | null) => void;
}

export function TaskListDescriptionContent({
  pageId,
  canEdit,
  initialContent,
  className,
  onEditorChange,
}: TaskListDescriptionContentProps) {
  const {
    document: docState,
    updateContent,
    saveWithDebounce,
    forceSave,
    initializeAndActivate,
  } = useDocument(pageId);

  // Seed the store from the parent's already-loaded page content to avoid a
  // redundant network fetch. Only fetches if the document isn't cached yet and
  // no initialContent was provided (e.g. a standalone mount without a tree page).
  useEffect(() => {
    const existing = useDocumentManagerStore.getState().documents.get(pageId);
    if (existing) return;
    if (initialContent !== undefined) {
      useDocumentManagerStore.getState().upsertDocument(pageId, initialContent ?? '', 'html');
    } else {
      initializeAndActivate();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // Register with useEditingStore while dirty so SWR doesn't revalidate mid-edit.
  useEffect(() => {
    const componentId = `task-description-${pageId}`;
    if (docState?.isDirty && canEdit) {
      useEditingStore.getState().startEditing(componentId, 'document', { pageId });
    } else {
      useEditingStore.getState().endEditing(componentId);
    }
    return () => { useEditingStore.getState().endEditing(componentId); };
  }, [docState?.isDirty, pageId, canEdit]);

  // Keep a stable ref so the unmount cleanup always calls the latest forceSave.
  const forceSaveRef = useRef(forceSave);
  useEffect(() => { forceSaveRef.current = forceSave; }, [forceSave]);
  useEffect(() => {
    return () => { forceSaveRef.current().catch(() => {}); };
  }, []);

  const handleChange = useCallback((html: string) => {
    updateContent(html);
    saveWithDebounce(html);
  }, [updateContent, saveWithDebounce]);

  const content = docState?.content ?? initialContent ?? '';

  return (
    <div className={className}>
      <RichEditor
        value={content}
        onChange={handleChange}
        readOnly={!canEdit}
        contentMode="html"
        onEditorChange={onEditorChange}
      />
    </div>
  );
}
