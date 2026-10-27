'use client';

import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { formatDistance } from 'date-fns';
import { EditableTitle } from '@/retained/components/layout/middle-content/content-header/EditableTitle';
import { EditorToggles } from '@/retained/components/layout/middle-content/content-header/EditorToggles';
import Toolbar from '@/retained/components/editors/Toolbar';
import type { DocumentToolbarState } from '@/retained/components/layout/middle-content/page-views/document/DocumentView';
import { FindBar } from '@/retained/components/find/FindBar';
import { useFindStore } from '@/retained/stores/useFindStore';
import { getEffectiveBinding, matchesKeyEvent } from '@/retained/stores/useHotkeyStore';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import { usePage } from '../page-object/page-object';
import { SaveStatus, type PageTypeProps } from './shared';

const DocumentView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/document/DocumentView'), { ssr: false });

/**
 * ⌘F on the document (IMC-9.10): opens the find strip, or refocuses its field when it is already
 * open. Skipped while Monaco has focus. The find state is cleared when the document unmounts.
 */
export function useFindShortcut(): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesKeyEvent(getEffectiveBinding('editing.find'), event)) return;
      if (document.activeElement?.closest('.monaco-editor')) return;
      event.preventDefault();
      const find = useFindStore.getState();
      if (find.isOpen) {
        const field = document.querySelector<HTMLInputElement>('[data-find-field]');
        field?.focus();
        field?.select();
      } else {
        find.open();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      useFindStore.getState().reset();
    };
  }, []);
}

/** The find strip under the Formatting strip (C-Files-Doc-Find); renders nothing while find is closed. */
export function FindStrip() {
  const isOpen = useFindStore((state) => state.isOpen);
  if (!isOpen) return null;
  return (
    <ToolbarStrip label="Find in page">
      <FindBar />
    </ToolbarStrip>
  );
}

/** The document's updatedAt from the page the route fetched, or null while it is unknown. */
export const editedAtOf = (data: unknown): Date | null => {
  if (typeof data !== 'object' || data === null || !('updatedAt' in data)) return null;
  const { updatedAt } = data;
  if (typeof updatedAt !== 'string' && !(updatedAt instanceof Date)) return null;
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** The board's muted meta line: "Edited 2 minutes ago". The "by <name>" part waits on needs-api. */
export const editedLabel = (updatedAt: Date, now: Date = new Date()): string =>
  `Edited ${formatDistance(updatedAt, now, { addSuffix: true })}`;

/**
 * The Formatting strip (C-Files-Doc): the optional Rich/Code mode group, the formatting tools while the
 * rich editor is on screen, and Saving… / Saved at the end.
 */
export function FormattingStrip({ pageId, state }: { readonly pageId: string; readonly state: DocumentToolbarState }) {
  return (
    <ToolbarStrip label="Formatting">
      <EditorToggles />
      {state.formatting ? <Toolbar editor={state.editor} contentMode={state.contentMode} /> : <div className="flex-1" />}
      <SaveStatus pageId={pageId} />
    </ToolbarStrip>
  );
}

/** The in-body title (34–40px) with the meta line above it, inside the document's scroll area. */
export function DocumentTitle({ pageId }: { readonly pageId: string }) {
  const { data } = usePage(pageId);
  const updatedAt = editedAtOf(data);
  return (
    <div className="pt-8">
      {updatedAt ? <p className="mb-2 text-xs text-ink-muted">{editedLabel(updatedAt)}</p> : null}
      <EditableTitle pageId={pageId} variant="body" />
    </div>
  );
}

/** A document in the v3 middle (C-Files-Doc): the Formatting strip, the in-body title, then the editor. */
export function DocumentPage({ page, driveId, pageId }: PageTypeProps) {
  useFindShortcut();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DocumentView
        pageId={pageId}
        driveId={driveId}
        renderToolbar={(state) => (
          <>
            <FormattingStrip pageId={page.id} state={state} />
            <FindStrip />
          </>
        )}
        bodyHeader={<DocumentTitle pageId={pageId} />}
      />
    </div>
  );
}
