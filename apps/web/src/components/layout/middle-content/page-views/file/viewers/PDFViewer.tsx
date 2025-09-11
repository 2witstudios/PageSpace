'use client';

import { useState, useEffect } from 'react';
import { TreePage } from '@/hooks/usePageTree';
import { Loader2 } from 'lucide-react';

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
    <div className="h-full bg-muted/10">
      {pdfUrl && (
        <iframe
          src={pdfUrl}
          className="w-full h-full"
          title={page.title}
          style={{ border: 'none' }}
        />
      )}
    </div>
  );
}