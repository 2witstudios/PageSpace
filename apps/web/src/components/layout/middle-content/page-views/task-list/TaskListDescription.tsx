'use client';

import { useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { type Editor } from '@tiptap/react';
import { useDocument } from '@/hooks/useDocument';
import DocumentConflictGate from '@/components/layout/middle-content/page-views/document/DocumentConflictGate';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useEditingStore } from '@/stores/useEditingStore';
import { resolveDescriptionSeed } from './description-seed';

const RichEditor = dynamic(() => import('@/components/editors/RichEditor'), { ssr: false });

interface TaskListDescriptionContentProps {
  pageId: string;
  canEdit: boolean;
  initialContent?: string | null;
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
    conflict,
    resolveConflict,
    isResolvingConflict,
  } = useDocument(pageId);

  // Seed the store from caller-provided content when there is some; otherwise fetch it.
  useEffect(() => {
    const seed = resolveDescriptionSeed({
      hasCachedDocument: useDocumentManagerStore.getState().documents.has(pageId),
      initialContent,
    });
    if (seed.kind === 'seed') {
      useDocumentManagerStore.getState().upsertDocument(pageId, seed.content, 'html');
    } else if (seed.kind === 'fetch') {
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
      <DocumentConflictGate
        conflict={conflict}
        onResolve={resolveConflict}
        isResolving={isResolvingConflict}
      />
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
