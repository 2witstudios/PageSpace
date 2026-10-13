'use client';

import dynamic from 'next/dynamic';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import { SaveStatus, type PageTypeProps } from './shared';

const SheetView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/sheet/SheetView'), { ssr: false });

/** A sheet in the v3 middle (C-Files-Sheet): its strip, then classic's grid. */
export function SheetPage({ page }: PageTypeProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarStrip label="Sheet">
        <div className="flex-1" />
        <SaveStatus pageId={page.id} />
      </ToolbarStrip>
      <div className="min-h-0 flex-1">
        <SheetView page={page} />
      </div>
    </div>
  );
}
