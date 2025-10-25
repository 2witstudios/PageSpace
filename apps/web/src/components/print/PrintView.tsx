'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import DOMPurify from 'dompurify';
import { calculatePageBreaks } from '@/lib/editor/pagination/page-breaker';
import ReadOnlyEditor from './ReadOnlyEditor';

// Page type from database
interface PageData {
  id: string;
  content: string | null;
  title: string;
  type: string;
}

interface PrintViewProps {
  page: PageData;
}

/**
 * PrintView - Client component for pre-paginated print rendering
 *
 * ## Phase 3 Implementation
 * Uses ReadOnlyEditor (Tiptap) to render content with exact same typography
 * as main editor. This ensures heights, spacing, and formatting match precisely
 * for accurate pagination calculations.
 *
 * ## Responsibilities
 * 1. Render content using read-only Tiptap editor (ensures typography parity)
 * 2. Wait for DOM to stabilize, then calculate page breaks
 * 3. Split content across fixed-height page containers
 * 4. Auto-trigger window.print() when ready
 * 5. Handle errors and cleanup
 *
 * ## Page Container Structure
 * Each page is a fixed-height div (816px × 1056px for Letter size) with
 * content split at calculated break points. Content elements are moved
 * (not cloned) to appropriate page containers.
 *
 * ## Print Trigger
 * Uses MutationObserver + requestIdleCallback to ensure DOM is fully
 * rendered and fonts are loaded before triggering print dialog.
 */
export default function PrintView({ page }: PrintViewProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isEditorMounted, setIsEditorMounted] = useState(false);
  const [pageContents, setPageContents] = useState<HTMLElement[][]>([]);
  const [error, setError] = useState<string | null>(null);
  const editorElementRef = useRef<HTMLElement | null>(null);
  const printTriggeredRef = useRef(false);

  // Handle editor mount - gives us access to rendered DOM
  const handleEditorMount = useCallback((element: HTMLElement | null) => {
    editorElementRef.current = element;
    if (element) {
      setIsEditorMounted(true);
    }
  }, []);

  // Calculate pagination after editor renders
  useEffect(() => {
    if (!isEditorMounted || !editorElementRef.current) {
      return;
    }

    async function calculatePagination() {
      try {
        // Wait for fonts to load
        await document.fonts.ready;

        if (!editorElementRef.current) {
          throw new Error('Editor element not found');
        }

        // Get the ProseMirror content container
        const proseMirrorContent = editorElementRef.current.querySelector('.ProseMirror');
        if (!proseMirrorContent) {
          throw new Error('ProseMirror container not found');
        }

        // Get all direct children of ProseMirror (content elements)
        const contentElements = Array.from(
          proseMirrorContent.children
        ) as HTMLElement[];

        if (contentElements.length === 0) {
          throw new Error('No content elements found');
        }

        // Calculate page breaks
        // Using default Letter size: 816px width, 800px content height
        const pageBreaks = calculatePageBreaks(contentElements, {
          pageContentAreaHeight: 800,
          overflowTolerance: 10,
        });

        // Split content elements into pages
        const pages: HTMLElement[][] = [];
        let currentPage: HTMLElement[] = [];
        let nextBreakIndex = 0;

        contentElements.forEach((element, index) => {
          // Check if this element is a break point
          if (nextBreakIndex < pageBreaks.length &&
              pageBreaks[nextBreakIndex].elementIndex === index) {
            // Start new page
            pages.push(currentPage);
            currentPage = [];
            nextBreakIndex++;
          }
          currentPage.push(element);
        });

        // Add final page
        if (currentPage.length > 0) {
          pages.push(currentPage);
        }

        setPageContents(pages);
        setIsLoading(false);

        // Log to console in client (can add analytics later)
        console.log('Print pagination calculated:', {
          pageId: page.id,
          totalBreaks: pageBreaks.length,
          totalPages: pages.length,
          elementsPerPage: pages.map(p => p.length),
        });
      } catch (err) {
        console.error('Pagination calculation error:', err);
        setError(err instanceof Error ? err.message : 'Failed to calculate pagination');
        setIsLoading(false);
      }
    }

    // Small delay to ensure Tiptap has fully rendered
    const timer = setTimeout(calculatePagination, 100);
    return () => clearTimeout(timer);
  }, [isEditorMounted, page.id]);

  // Auto-trigger print when pagination is complete
  useEffect(() => {
    if (isLoading || error || printTriggeredRef.current || pageContents.length === 0) {
      return;
    }

    // Trigger print after a short delay to ensure DOM is stable
    const timer = setTimeout(() => {
      if (!printTriggeredRef.current) {
        printTriggeredRef.current = true;

        // Use requestIdleCallback for better timing
        if ('requestIdleCallback' in window) {
          requestIdleCallback(() => {
            window.print();
          });
        } else {
          setTimeout(() => {
            window.print();
          }, 100);
        }
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [isLoading, error, pageContents]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4" />
          <h2 className="text-lg font-semibold mb-2">Preparing print preview...</h2>
          <p className="text-sm text-muted-foreground">
            Calculating page breaks and formatting content
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h2 className="text-lg font-semibold mb-2 text-destructive">Error</h2>
          <p className="text-sm text-muted-foreground">{error}</p>
          <button
            onClick={() => window.close()}
            className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <style jsx global>{`
        @media print {
          /* Remove all margins to prevent browser headers/footers */
          @page {
            size: 8.5in 11in;
            margin: 0;
          }

          html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: auto;
          }

          /* Hide loading UI and non-print elements */
          .no-print {
            display: none !important;
          }

          /* Hide the hidden editor used for measurements */
          .hidden-editor {
            display: none !important;
          }

          /* Ensure page breaks work */
          .print-page {
            page-break-after: always;
            break-after: page;
          }

          .print-page:last-child {
            page-break-after: auto;
            break-after: auto;
          }

          /* Ensure content doesn't get orphaned */
          .print-page > * {
            page-break-inside: avoid;
          }
        }

        /* Screen styles for preview */
        @media screen {
          .print-page {
            width: 816px; /* 8.5in at 96dpi */
            min-height: 1056px; /* 11in at 96dpi */
            margin: 20px auto;
            padding: 96px; /* 1in margins */
            background: white;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
          }

          /* Hide the editor used for measurements */
          .hidden-editor {
            position: absolute;
            left: -9999px;
            visibility: hidden;
            pointer-events: none;
          }
        }

        /* Tiptap styles for print */
        .print-page .tiptap {
          outline: none;
        }

        .print-page .tiptap p {
          margin: 1em 0;
        }

        .print-page .tiptap h1,
        .print-page .tiptap h2,
        .print-page .tiptap h3 {
          margin-top: 1.5em;
          margin-bottom: 0.5em;
        }
      `}</style>

      <div className="print-container">
        <div className="no-print text-center py-4 text-sm text-muted-foreground">
          Print preview ready ({pageContents.length} {pageContents.length === 1 ? 'page' : 'pages'}). Close this window to cancel printing.
        </div>

        {/* Hidden editor for measurements - rendered off-screen */}
        <div className="hidden-editor">
          <ReadOnlyEditor
            content={page.content || '<p></p>'}
            onMount={handleEditorMount}
          />
        </div>

        {/* Render split content across pages */}
        {pageContents.length > 0 ? (
          pageContents.map((pageElements, pageIndex) => (
            <div key={pageIndex} className="print-page">
              {pageElements.map((element, elementIndex) => {
                // SECURITY: Defense-in-depth sanitization with DOMPurify
                // Primary protection: Content originates from Tiptap's ProseMirror schema
                // which enforces an allowlist of safe HTML elements and attributes.
                // Secondary protection: DOMPurify sanitization provides additional XSS
                // protection in case of vulnerability in Tiptap or its extensions.
                const sanitizedHTML = DOMPurify.sanitize(element.outerHTML, {
                  ALLOWED_TAGS: [
                    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                    'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
                    'strong', 'em', 'u', 's', 'a', 'br',
                    'table', 'thead', 'tbody', 'tr', 'th', 'td',
                    'div', 'span', 'img',
                  ],
                  ALLOWED_ATTR: ['href', 'class', 'style', 'src', 'alt', 'title'],
                });

                return (
                  <div
                    key={elementIndex}
                    dangerouslySetInnerHTML={{ __html: sanitizedHTML }}
                  />
                );
              })}
            </div>
          ))
        ) : (
          // Fallback if pagination hasn't completed yet
          <div className="print-page">
            <ReadOnlyEditor content={page.content || '<p></p>'} />
          </div>
        )}
      </div>
    </>
  );
}
