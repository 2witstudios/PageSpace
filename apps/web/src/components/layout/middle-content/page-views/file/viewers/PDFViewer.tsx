'use client';

import { useState, useEffect, ComponentType, ReactNode } from 'react';
import { TreePage } from '@/hooks/usePageTree';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

/**
 * Type definitions for react-pdf components
 * Using interfaces instead of importing types to avoid SSR issues with the library
 */
interface DocumentProps {
  file: ArrayBuffer | string | { url: string } | null;
  onLoadSuccess?: (pdf: { numPages: number }) => void;
  loading?: ReactNode;
  children?: ReactNode;
}

interface PageProps {
  pageNumber: number;
  className?: string;
  renderTextLayer?: boolean;
  renderAnnotationLayer?: boolean;
}

interface PdfJs {
  version: string;
  GlobalWorkerOptions: {
    workerSrc: string;
  };
}

// Store components loaded dynamically to avoid SSR issues
let DocumentComponent: ComponentType<DocumentProps> | null = null;
let PageComponent: ComponentType<PageProps> | null = null;
let pdfjsLib: PdfJs | null = null;

// Initialize react-pdf on client side only
if (typeof window !== 'undefined') {
  // Dynamic import using require for CSS and module loading
  // This pattern is necessary for react-pdf which doesn't support ESM SSR
  const loadReactPdf = async () => {
    const reactPdf = await import('react-pdf');
    DocumentComponent = reactPdf.Document as ComponentType<DocumentProps>;
    PageComponent = reactPdf.Page as ComponentType<PageProps>;
    pdfjsLib = reactPdf.pdfjs as unknown as PdfJs;

    // Set up the worker for PDF.js
    pdfjsLib.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  };

  // Import styles - these are side-effect only imports
  import('react-pdf/dist/Page/AnnotationLayer.css');
  import('react-pdf/dist/Page/TextLayer.css');

  // Trigger the load
  loadReactPdf();
}

interface PDFViewerProps {
  page: TreePage;
}

export default function PDFViewer({ page }: PDFViewerProps) {
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isClient, setIsClient] = useState(false);

  // Check if we're on the client
  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    if (!isClient) return;
    
    const loadPdf = async () => {
      try {
        setIsLoading(true);
        const response = await fetchWithAuth(`/api/files/${page.id}/view`);
        if (!response.ok) {
          throw new Error(`Failed to load PDF: ${response.status}`);
        }
        const data = await response.arrayBuffer();
        setPdfData(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load PDF');
      } finally {
        setIsLoading(false);
      }
    };

    loadPdf();
  }, [page.id, isClient]);

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
  }

  if (!isClient) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

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

  if (!DocumentComponent || !PageComponent) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">PDF viewer is loading...</p>
      </div>
    );
  }

  const Document = DocumentComponent;
  const Page = PageComponent;

  return (
    <div className="h-full flex flex-col">
      {/* PDF Navigation Controls */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPageNumber(pageNumber - 1)}
            disabled={pageNumber <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm">
            Page {pageNumber} of {numPages || '...'}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPageNumber(pageNumber + 1)}
            disabled={pageNumber >= (numPages || 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* PDF Document */}
      <div className="flex-1 overflow-auto flex justify-center p-4">
        {pdfData && (
          <Document
            file={pdfData}
            onLoadSuccess={onDocumentLoadSuccess}
            loading={
              <div className="flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <Page
              pageNumber={pageNumber}
              className="shadow-lg"
              renderTextLayer={true}
              renderAnnotationLayer={true}
            />
          </Document>
        )}
      </div>
    </div>
  );
}