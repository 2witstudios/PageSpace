"use client";

import React from 'react';
import DocumentConflictBanner from './DocumentConflictBanner';
import type {
  ConflictResolutionChoice,
  DocumentConflict,
} from '@/lib/documents/conflict-resolution';

interface DocumentConflictGateProps {
  /** From the view's OWN `useDocument(pageId)` — see the note below. */
  conflict: DocumentConflict | undefined;
  onResolve: (choice: ConflictResolutionChoice) => void;
  isResolving?: boolean;
  previewMode?: 'rich' | 'plain';
}

/**
 * Conflict surface for every editor built on `useDocument`.
 *
 * `useDocument` pauses autosave for a page while a conflict is parked, so any
 * view that can save MUST also offer a way to resolve one — otherwise saving
 * stops for the rest of the session with nothing on screen to explain it. This
 * component is that guarantee in one place: it renders nothing until a conflict
 * exists, so views mount it unconditionally.
 *
 * It takes the conflict and the resolver as PROPS rather than calling
 * `useDocument` itself, deliberately. A second hook instance for the same page
 * would mint a second `sessionId` (`useDocumentSaving`), and that value is sent
 * as `changeGroupId` — which `applyPageMutation` threads into both
 * `createPageVersion` and `logActivityWithTx`. A resolution save from its own
 * instance would therefore land in its own change group, splitting the version
 * and activity grouping at exactly the moment a user resolved a conflict. It
 * would also give the view and this component two independent `isResolving`
 * booleans for one logical operation.
 */
const DocumentConflictGate = ({
  conflict,
  onResolve,
  isResolving,
  previewMode,
}: DocumentConflictGateProps) => {
  if (!conflict) return null;

  return (
    <DocumentConflictBanner
      conflict={conflict}
      previewMode={previewMode}
      onResolve={onResolve}
      isResolving={isResolving}
    />
  );
};

export default DocumentConflictGate;
