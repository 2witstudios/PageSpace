'use client';

import { FileIcon, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/utils';
import { TreePage } from '@/hooks/usePageTree';

interface GenericFileViewerProps {
  page: TreePage;
}

export default function GenericFileViewer({ page }: GenericFileViewerProps) {
  const handleDownload = async () => {
    try {
      const response = await fetch(`/api/files/${page.id}/download`);
      if (!response.ok) {
        throw new Error('Failed to download file');
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = page.originalFileName || page.title;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <FileIcon className="h-24 w-24 text-muted-foreground mb-4" />
      
      <h2 className="text-2xl font-semibold mb-2">{page.title}</h2>
      
      {page.originalFileName && page.originalFileName !== page.title && (
        <p className="text-sm text-muted-foreground mb-1">
          Original: {page.originalFileName}
        </p>
      )}
      
      <div className="text-sm text-muted-foreground mb-6">
        {page.mimeType && <p>Type: {page.mimeType}</p>}
        {page.fileSize && <p>Size: {formatBytes(page.fileSize)}</p>}
      </div>
      
      <p className="text-muted-foreground mb-6">
        Preview not available for this file type
      </p>
      
      <Button onClick={handleDownload} size="lg">
        <Download className="mr-2 h-4 w-4" />
        Download File
      </Button>
    </div>
  );
}