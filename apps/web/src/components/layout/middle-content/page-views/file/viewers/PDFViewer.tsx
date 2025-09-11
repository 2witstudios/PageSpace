'use client';

import { useState, useEffect } from 'react';
import { TreePage } from '@/hooks/usePageTree';
import { Loader2, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PDFViewerProps {
  page: TreePage;
}

export default function PDFViewer({ page }: PDFViewerProps) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadPdf = async () => {
      try {
        setIsLoading(true);
        // Use /view route for inline display in iframe
        const url = `/api/files/${page.id}/view`;
        setPdfUrl(url);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load PDF');
      } finally {
        setIsLoading(false);
      }
    };

    loadPdf();
  }, [page.id]);

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* PDF Viewer Controls */}
      <div className="flex items-center justify-between p-2 border-b bg-background">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {page.originalFileName || page.title}
          </span>
        </div>
        <Button
          onClick={handleDownload}
          variant="ghost"
          size="sm"
        >
          <Download className="h-4 w-4" />
        </Button>
      </div>

      {/* PDF Display */}
      <div className="flex-1 bg-muted/10">
        {pdfUrl && (
          <iframe
            src={pdfUrl}
            className="w-full h-full"
            title={page.title}
            style={{ border: 'none' }}
          />
        )}
      </div>
    </div>
  );
}