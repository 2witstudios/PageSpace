'use client';

import { FileIcon } from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { TreePage } from '@/hooks/usePageTree';

interface GenericFileViewerProps {
  page: TreePage;
}

export default function GenericFileViewer({ page }: GenericFileViewerProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <FileIcon className="h-24 w-24 text-muted-foreground mb-4" />
      
      {page.originalFileName && (
        <p className="text-sm text-muted-foreground mb-1">
          {page.originalFileName}
        </p>
      )}
      
      <div className="text-sm text-muted-foreground mb-6">
        {page.mimeType && <p>Type: {page.mimeType}</p>}
        {page.fileSize && <p>Size: {formatBytes(page.fileSize)}</p>}
      </div>
      
      <p className="text-muted-foreground">
        Preview not available for this file type
      </p>
    </div>
  );
}