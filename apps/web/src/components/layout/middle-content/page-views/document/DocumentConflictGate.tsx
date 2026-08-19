"use client";

import React from 'react';
import { useDocument } from '@/hooks/useDocument';
import DocumentConflictBanner from './DocumentConflictBanner';

interface DocumentConflictGateProps {
  pageId: string;
  previewMode?: 'rich' | 'plain';
}

/**
 * Drop-in conflict surface for every editor built on `useDocument`.
 *
 * `useDocument` pauses autosave for a page while a conflict is parked, so any
 * view that can save MUST also offer a way to resolve one — otherwise saving
 * stops for the rest of the session with nothing on screen to explain it. This
 * component is that guarantee in one line: it renders nothing until a conflict
 * exists for `pageId`, so views can mount it unconditionally.
 */
const DocumentConflictGate = ({ pageId, previewMode }: DocumentConflictGateProps) => {
  const { conflict, resolveConflict, isResolvingConflict } = useDocument(pageId);

  if (!conflict) return null;

  return (
    <DocumentConflictBanner
      conflict={conflict}
      previewMode={previewMode}
      onResolve={resolveConflict}
      isResolving={isResolvingConflict}
    />
  );
};

export default DocumentConflictGate;
