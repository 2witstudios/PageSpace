'use client';

import { useState, useEffect } from 'react';
import { TreePage } from '@/hooks/usePageTree';
import { Loader2, FileText, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { useParams } from 'next/navigation';
import DOMPurify from 'dompurify';
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

interface DocxViewerProps {
  page: TreePage;
}

export default function DocxViewer({ page }: DocxViewerProps) {
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConvertDialog, setShowConvertDialog] = useState(false);
  const [newDocumentTitle, setNewDocumentTitle] = useState('');
  const router = useRouter();
  const params = useParams();
  const driveId = params.driveId as string;

  useEffect(() => {
    const loadAndConvertDocx = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Fetch the DOCX file
        const response = await fetch(`/api/files/${page.id}/view`);
        if (!response.ok) {
          throw new Error('Failed to load document');
        }

        // Get the file as a blob
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();

        // Dynamically import mammoth to avoid SSR issues
        const mammoth = (await import('mammoth')).default;

        // Convert DOCX to HTML
        const result = await mammoth.convertToHtml({ arrayBuffer });
        
        if (result.messages && result.messages.length > 0) {
          console.warn('Conversion messages:', result.messages);
        }

        // Sanitize the HTML to prevent XSS
        const sanitizedHtml = DOMPurify.sanitize(result.value, {
          ADD_TAGS: ['style'],
          ADD_ATTR: ['style', 'class'],
        });

        setHtmlContent(sanitizedHtml);
        
        // Set default title for conversion
        const baseTitle = page.title.replace(/\.(docx?|DOCX?)$/, '');
        setNewDocumentTitle(baseTitle);
      } catch (err) {
        console.error('Failed to convert DOCX:', err);
        setError(err instanceof Error ? err.message : 'Failed to load document');
      } finally {
        setIsLoading(false);
      }
    };

    loadAndConvertDocx();
  }, [page.id, page.title]);

  const handleConvertToDocument = async () => {
    if (!newDocumentTitle.trim()) {
      toast.error('Please enter a title for the new document');
      return;
    }

    setIsConverting(true);
    try {
      const response = await fetch(`/api/files/${page.id}/convert-to-document`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: newDocumentTitle,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to convert document');
      }

      const { pageId } = await response.json();
      
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
          <p className="text-sm text-muted-foreground">Converting document...</p>
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
              <p className="text-sm font-medium">Word Document Preview</p>
              <p className="text-xs text-muted-foreground">
                {page.originalFileName || page.title}
              </p>
            </div>
          </div>
          <Button
            onClick={() => setShowConvertDialog(true)}
            disabled={!htmlContent}
            size="sm"
          >
            <ArrowRight className="mr-2 h-4 w-4" />
            Convert to Document
          </Button>
        </div>

        {/* Document preview */}
        <div className="flex-1 overflow-auto p-6 bg-background">
          <div 
            className="mx-auto max-w-4xl prose prose-sm dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: htmlContent || '' }}
            style={{
              // Add some default styles for better Word document rendering
              lineHeight: '1.6',
              fontSize: '14px',
            }}
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