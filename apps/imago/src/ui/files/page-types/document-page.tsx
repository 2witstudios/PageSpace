'use client';

import dynamic from 'next/dynamic';
import { EditorToggles } from '@/retained/components/layout/middle-content/content-header/EditorToggles';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import { SaveStatus, type PageTypeProps } from './shared';

const DocumentView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/document/DocumentView'), { ssr: false });

/** A document in the v3 middle (C-Files-Doc): the Formatting strip, then classic's editor. */
export function DocumentPage({ page, driveId, pageId }: PageTypeProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarStrip label="Formatting">
        <EditorToggles />
        <div className="flex-1" />
        <SaveStatus pageId={page.id} />
      </ToolbarStrip>
      <div className="min-h-0 flex-1">
        <DocumentView pageId={pageId} driveId={driveId} />
      </div>
    </div>
  );
}
