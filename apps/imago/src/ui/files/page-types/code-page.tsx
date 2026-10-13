'use client';

import dynamic from 'next/dynamic';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import { SaveStatus, type PageTypeProps } from './shared';

const CodePageView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/code/CodePageView'), { ssr: false });

/** A code page in the v3 middle (C-Files-Code): its strip, then classic's editor. */
export function CodePage({ page, driveId, pageId }: PageTypeProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarStrip label="Code">
        <div className="flex-1" />
        <SaveStatus pageId={page.id} />
      </ToolbarStrip>
      <div className="min-h-0 flex-1">
        <CodePageView pageId={pageId} driveId={driveId} />
      </div>
    </div>
  );
}
