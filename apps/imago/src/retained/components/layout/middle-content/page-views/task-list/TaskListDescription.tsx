'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { type Editor } from '@tiptap/react';
import { useDocument } from '@/retained/hooks/useDocument';
import DocumentConflictGate from '@/retained/components/layout/middle-content/page-views/document/DocumentConflictGate';
import { useDocumentManagerStore } from '@/retained/stores/useDocumentManagerStore';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import { Button } from '@/retained/components/ui/button';
import { resolveDescriptionSeed } from './description-seed';

const RichEditor = dynamic(() => import('@/retained/components/editors/RichEditor'), { ssr: false });

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

  // Set when the fetch failed with nothing cached. Nothing is stored in that case, so the next attempt
  // fetches again instead of finding an empty description cached as if it were real.
  // Keyed by page: the component survives a pageId change, and a late result for the page it left must not
  // clear or set the failure shown for the current one.
  const [failedPageId, setFailedPageId] = useState<string | null>(null);
  const loadFailed = failedPageId === pageId;
  const loadDescription = useCallback(async () => {
    setFailedPageId((failed) => (failed === pageId ? null : failed));
    const loaded = await initializeAndActivate({ emptyOnFailure: false });
    setFailedPageId((failed) => (loaded ? (failed === pageId ? null : failed) : pageId));
  }, [initializeAndActivate, pageId]);

  // Seed the store from caller-provided content when there is some; otherwise fetch it.
  useEffect(() => {
    const seed = resolveDescriptionSeed({
      hasCachedDocument: useDocumentManagerStore.getState().documents.has(pageId),
      initialContent,
    });
    if (seed.kind === 'seed') {
      useDocumentManagerStore.getState().upsertDocument(pageId, seed.content, 'html');
    } else if (seed.kind === 'fetch') {
      void loadDescription();
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

  if (loadFailed && !docState) {
    return (
      <div className={className}>
        <div role="alert" className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>The description could not be loaded.</span>
          <Button variant="outline" size="sm" onClick={() => void loadDescription()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

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
        // No document record yet means the content is still loading; edits to the placeholder would be lost.
        readOnly={!canEdit || !docState}
        contentMode="html"
        onEditorChange={onEditorChange}
      />
    </div>
  );
}
