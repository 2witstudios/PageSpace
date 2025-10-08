'use client';

import { useState, useEffect, useRef } from 'react';
import { TreePage } from '@/hooks/usePageTree';
import { Loader2, FileText, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { useParams } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { post } from '@/lib/auth-fetch';

interface DocxViewerProps {
  page: TreePage;
}

export default function DocxViewer({ page }: DocxViewerProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConvertDialog, setShowConvertDialog] = useState(false);
  const [newDocumentTitle, setNewDocumentTitle] = useState('');
  const [docxData, setDocxData] = useState<ArrayBuffer | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const params = useParams();
  const driveId = params.driveId as string;

  // Load the DOCX file data
  useEffect(() => {
    setIsLoading(true);
    setError(null);
    
    fetch(`/api/files/${page.id}/view`)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to load document: ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then(data => {
        console.log('DOCX data loaded:', data.byteLength, 'bytes');
        setDocxData(data);
        // Set default title for conversion
        const baseTitle = page.title.replace(/\.(docx?|DOCX?)$/, '');
        setNewDocumentTitle(baseTitle);
      })
      .catch(err => {
        console.error('Failed to load DOCX:', err);
        setError(err instanceof Error ? err.message : 'Failed to load document');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [page.id, page.title]);

  // Render the DOCX when data is ready and container exists
  useEffect(() => {
    if (!docxData || !previewContainerRef.current) {
      console.log('Waiting for data or container:', { 
        hasData: !!docxData, 
        hasContainer: !!previewContainerRef.current 
      });
      return;
    }

    console.log('Rendering DOCX with container:', previewContainerRef.current);
    
    // Clear any existing content
    previewContainerRef.current.innerHTML = '';
    
    // Import and render
    import('docx-preview')
      .then(({ renderAsync }) => {
        console.log('Calling renderAsync...');
        return renderAsync(docxData, previewContainerRef.current!, undefined, { 
          inWrapper: false 
        });
      })
      .then(() => {
        console.log('DOCX rendered successfully');
      })
      .catch(err => {
        console.error('Failed to render DOCX:', err);
        setError(err instanceof Error ? err.message : 'Failed to render document');
      });
  }, [docxData]);

  const handleConvertToDocument = async () => {
    if (!newDocumentTitle.trim()) {
      toast.error('Please enter a title for the new document');
      return;
    }

    setIsConverting(true);
    try {
      const { pageId } = await post<{ pageId: string }>(`/api/files/${page.id}/convert-to-document`, {
        title: newDocumentTitle,
      });

      toast.success('Document converted successfully!');
      setShowConvertDialog(false);

      // Navigate to the new document
      router.push(`/dashboard/${driveId}/${pageId}`);
    } catch (error) {
      console.error('Conversion error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to convert document');
    } finally {
      setIsConverting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Loading document...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <FileText className="h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-muted-foreground mb-2">Error loading document</p>
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  return (
    <>
      <div className="h-full flex flex-col">
        {/* Conversion toolbar */}
        <div className="flex items-center justify-between p-4 border-b bg-muted/50">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Word Document</p>
              <p className="text-xs text-muted-foreground">
                {page.originalFileName || page.title}
              </p>
            </div>
          </div>
          <Button
            onClick={() => setShowConvertDialog(true)}
            size="sm"
          >
            <ArrowRight className="mr-2 h-4 w-4" />
            Convert to Document
          </Button>
        </div>

        {/* Document preview container */}
        <div className="flex-1 p-4 overflow-hidden flex justify-center">
          <div 
            ref={previewContainerRef}
            className="bg-white rounded overflow-auto shadow-lg"
            style={{ 
              minHeight: '600px',
              width: 'fit-content',
              maxWidth: '100%',
              height: 'calc(100vh - 200px)',
              display: 'block',
              position: 'relative'
            }}
            suppressHydrationWarning={true}
          />
        </div>
      </div>

      {/* Conversion dialog */}
      <Dialog open={showConvertDialog} onOpenChange={setShowConvertDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convert to PageSpace Document</DialogTitle>
            <DialogDescription>
              This will create a new editable document from this Word file. The original file will be preserved.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="title">Document Title</Label>
              <Input
                id="title"
                value={newDocumentTitle}
                onChange={(e) => setNewDocumentTitle(e.target.value)}
                placeholder="Enter document title..."
                disabled={isConverting}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowConvertDialog(false)}
              disabled={isConverting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConvertToDocument}
              disabled={isConverting || !newDocumentTitle.trim()}
            >
              {isConverting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Converting...
                </>
              ) : (
                <>
                  <ArrowRight className="mr-2 h-4 w-4" />
                  Convert
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}