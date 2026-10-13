'use client';

import dynamic from 'next/dynamic';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import { DownloadFile, type PageTypeProps } from './shared';

const FileView = dynamic(() => import('@/retained-adapters/file-view'), { ssr: false });

/** A file in the v3 middle (C-Files-File): its strip with Download, then classic's viewer. */
export function FilePage({ page, driveId, pageId }: PageTypeProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarStrip label="File">
        <div className="flex-1" />
        <DownloadFile page={page} />
      </ToolbarStrip>
      <div className="min-h-0 flex-1">
        <FileView driveId={driveId} pageId={pageId} />
      </div>
    </div>
  );
}
