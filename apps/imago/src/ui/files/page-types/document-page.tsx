'use client';

import dynamic from 'next/dynamic';
import { formatDistance } from 'date-fns';
import { EditableTitle } from '@/retained/components/layout/middle-content/content-header/EditableTitle';
import { EditorToggles } from '@/retained/components/layout/middle-content/content-header/EditorToggles';
import Toolbar from '@/retained/components/editors/Toolbar';
import type { DocumentToolbarState } from '@/retained/components/layout/middle-content/page-views/document/DocumentView';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import { usePage } from '../page-object/page-object';
import { SaveStatus, type PageTypeProps } from './shared';

const DocumentView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/document/DocumentView'), { ssr: false });

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
 * The Formatting strip (C-Files-Doc): the Rich/Markdown mode group, the formatting tools while the
 * rich editor is on screen, and Saving… / Saved at the end.
 */
export function FormattingStrip({ pageId, state }: { readonly pageId: string; readonly state: DocumentToolbarState }) {
  return (
    <ToolbarStrip label="Formatting">
      <EditorToggles alwaysShow />
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DocumentView
        pageId={pageId}
        driveId={driveId}
        renderToolbar={(state) => <FormattingStrip pageId={page.id} state={state} />}
        bodyHeader={<DocumentTitle pageId={pageId} />}
      />
    </div>
  );
}
